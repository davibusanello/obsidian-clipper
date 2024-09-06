import dayjs from 'dayjs';
import { Template, Property } from '../types/types';
import { generateFrontmatter, saveToObsidian, sanitizeFileName } from '../utils/obsidian-note-creator';
import { extractPageContent, initializePageContent, replaceVariables } from '../utils/content-extractor';
import { initializeIcons, getPropertyTypeIcon } from '../icons/icons';
import { unescapeValue } from '../utils/string-utils';
import { decompressFromUTF16 } from 'lz-string';

let currentTemplate: Template | null = null;
let templates: Template[] = [];

document.addEventListener('DOMContentLoaded', function() {
	const vaultContainer = document.getElementById('vault-container') as HTMLElement;
	const vaultDropdown = document.getElementById('vault-select') as HTMLSelectElement;
	const templateContainer = document.getElementById('template-container') as HTMLElement;
	const templateDropdown = document.getElementById('template-select') as HTMLSelectElement;

	let vaults: string[] = [];

	// Load vaults from storage and populate dropdown
	chrome.storage.sync.get(['vaults'], (data: { vaults?: string[] }) => {
		vaults = data.vaults || [];
		updateVaultDropdown();
	});

	function updateVaultDropdown() {
		vaultDropdown.innerHTML = '';
		
		vaults.forEach(vault => {
			const option = document.createElement('option');
			option.value = vault;
			option.textContent = vault;
			vaultDropdown.appendChild(option);
		});

		// Only show vault selector if one is defined
		if (vaults.length > 0) {
			vaultContainer.style.display = 'block';
			vaultDropdown.value = vaults[0];
		} else {
			vaultContainer.style.display = 'none';
		}
	}

	function findMatchingTemplate(url: string): Template | undefined {
		return templates.find(template => 
			template.urlPatterns && template.urlPatterns.some(pattern => url.startsWith(pattern))
		);
	}

	// Load templates from local storage and populate dropdown
	chrome.storage.local.get(['template_list'], async (data: { template_list?: string[] }) => {
		const templateIds = data.template_list || [];
		const loadedTemplates = await Promise.all(templateIds.map(id => 
			new Promise<Template | null>(resolve => 
				chrome.storage.local.get(`template_${id}`, data => {
					const compressedChunks = data[`template_${id}`];
					if (compressedChunks) {
						const decompressedData = decompressFromUTF16(compressedChunks.join(''));
						resolve(JSON.parse(decompressedData));
					} else {
						resolve(null);
					}
				})
			)
		));

		templates = loadedTemplates.filter((t): t is Template => t !== null);

		if (templates.length === 0) {
			console.error('No templates found in storage');
			return;
		}

		templateDropdown.innerHTML = '';
		
		templates.forEach((template: Template) => {
			const option = document.createElement('option');
			option.value = template.name;
			option.textContent = template.name;
			templateDropdown.appendChild(option);
		});

		// After templates are loaded, match template based on URL
		chrome.tabs.query({active: true, currentWindow: true}, async function(tabs) {
			if (!tabs[0].url || tabs[0].url.startsWith('chrome-extension://') || tabs[0].url.startsWith('chrome://') || tabs[0].url.startsWith('about:') || tabs[0].url.startsWith('file://')) {
				showError('This page cannot be clipped.');
				return;
			}

			const currentUrl = tabs[0].url;

			// Find matching template
			currentTemplate = findMatchingTemplate(currentUrl) || templates[0];

			// Update the template dropdown to reflect the matched template
			if (currentTemplate) {
				templateDropdown.value = currentTemplate.name;
			}

			if (tabs[0].id) {
				const extractedData = await extractPageContent(tabs[0].id);
				if (extractedData) {
					const initializedContent = await initializePageContent(extractedData.content, extractedData.selectedHtml, extractedData.extractedContent, currentUrl, extractedData.schemaOrgData);
					if (initializedContent && currentTemplate) {
						await initializeTemplateFields(currentTemplate, initializedContent.currentVariables, initializedContent.noteName);
					} else {
						showError('Unable to initialize page content.');
					}
				} else {
					showError('Unable to retrieve page content. Try reloading the page.');
				}
			}
		});

		// Set the first template as the default
		currentTemplate = templates[0];
		if (currentTemplate) {
			templateDropdown.value = currentTemplate.name;
		}

		// Only show template selector if there are multiple templates
		if (templates.length > 1) {
			templateContainer.style.display = 'block';
		}

		if (currentTemplate) {
			initializeTemplateFields(currentTemplate, {});
		}
	});

	// Template selection change
	templateDropdown.addEventListener('change', async function(this: HTMLSelectElement) {
		currentTemplate = templates.find((t: Template) => t.name === this.value) || null;
		if (currentTemplate) {
			const tabs = await chrome.tabs.query({active: true, currentWindow: true});
			if (tabs[0].id) {
				const extractedData = await extractPageContent(tabs[0].id);
				if (extractedData) {
					const initializedContent = await initializePageContent(extractedData.content, extractedData.selectedHtml, extractedData.extractedContent, tabs[0].url!, extractedData.schemaOrgData);
					if (initializedContent) {
						await initializeTemplateFields(currentTemplate, initializedContent.currentVariables, initializedContent.noteName);
					} else {
						showError('Unable to initialize page content.');
					}
				} else {
					showError('Unable to retrieve page content. Try reloading the page.');
				}
			}
		}
	});

	async function initializeTemplateFields(template: Template, currentVariables: { [key: string]: string }, noteName?: string) {
		const templateProperties = document.querySelector('.metadata-properties') as HTMLElement;
		templateProperties.innerHTML = '';

		const tabs = await chrome.tabs.query({active: true, currentWindow: true});
		const tabId = tabs[0].id!;

		for (const property of template.properties) {
			const propertyDiv = document.createElement('div');
			propertyDiv.className = 'metadata-property';
			let value = await replaceVariables(tabId, unescapeValue(property.value), currentVariables);

			// Apply type-specific parsing
			switch (property.type) {
				case 'number':
					const numericValue = value.replace(/[^\d.-]/g, '');
					value = numericValue ? parseFloat(numericValue).toString() : value;
					break;
				case 'checkbox':
					value = (value.toLowerCase() === 'true' || value === '1').toString();
					break;
				case 'date':
					value = dayjs(value).isValid() ? dayjs(value).format('YYYY-MM-DD') : value;
					break;
				case 'datetime':
					value = dayjs(value).isValid() ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : value;
					break;
			}

			propertyDiv.innerHTML = `
				<span class="metadata-property-icon"><i data-lucide="${getPropertyTypeIcon(property.type)}"></i></span>
				<label for="${property.name}">${property.name}</label>
				<input id="${property.name}" type="text" value="${escapeHtml(value)}" data-type="${property.type}" />
			`;
			templateProperties.appendChild(propertyDiv);
		}

		const noteNameField = document.getElementById('note-name-field') as HTMLInputElement;
		if (noteNameField) {
			let formattedNoteName = await replaceVariables(tabId, template.noteNameFormat, currentVariables);
			noteNameField.value = sanitizeFileName(formattedNoteName);
		}

		const pathField = document.getElementById('path-name-field') as HTMLInputElement;
		if (pathField) pathField.value = template.path;

		const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
		if (noteContentField) {
			if (template.noteContentFormat) {
				let content = await replaceVariables(tabId, template.noteContentFormat, currentVariables);
				noteContentField.value = content;
			} else {
				noteContentField.value = '';
			}
		}

		initializeIcons();
	}

	document.getElementById('clip-button')!.addEventListener('click', async function() {
		if (!currentTemplate) return;

		const vaultDropdown = document.getElementById('vault-select') as HTMLSelectElement;
		const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
		const noteNameField = document.getElementById('note-name-field') as HTMLInputElement;
		const pathField = document.getElementById('path-name-field') as HTMLInputElement;

		if (!vaultDropdown || !noteContentField || !noteNameField || !pathField) {
			showError('Some required fields are missing. Please try reloading the extension.');
			return;
		}

		const selectedVault = vaultDropdown.value;
		const noteContent = noteContentField.value;
		const noteName = noteNameField.value;
		const path = pathField.value;

		const properties = Array.from(document.querySelectorAll('.metadata-property input')).map(input => ({
			name: input.id,
			value: (input as HTMLInputElement).value,
			type: input.getAttribute('data-type') || 'text'
		}));

		let fileContent: string;
		if (currentTemplate.behavior === 'create') {
			const frontmatter = await generateFrontmatter(properties as Property[]);
			fileContent = frontmatter + noteContent;
		} else {
			fileContent = noteContent;
		}

		saveToObsidian(fileContent, noteName, path, selectedVault, currentTemplate.behavior, currentTemplate.specificNoteName, currentTemplate.dailyNoteFormat);
	});

	document.getElementById('open-settings')!.addEventListener('click', function() {
		chrome.runtime.openOptionsPage();
	});

	function showError(message: string) {
		const errorMessage = document.querySelector('.error-message') as HTMLElement;
		const clipper = document.querySelector('.clipper') as HTMLElement;

		errorMessage.textContent = message;
		errorMessage.style.display = 'block';
		clipper.style.display = 'none';
	}
});

function escapeHtml(unsafe: string): string {
	return unsafe
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}
