/**
 * Custom Component Registry
 * 
 * Maps component IDs (strings) to actual Svelte components.
 * This enables the data-driven settings structure to reference
 * complex components without circular import issues.
 * 
 * Usage in settings data:
 *   { type: 'custom', componentId: 'ModelSelector' }
 * 
 * The SettingRenderer will look up the component from this registry
 * and render it dynamically.
 */

import type { Component } from 'svelte';

// Import custom components here
import SeparateParametersSection from 'src/lib/Setting/Pages/SeparateParametersSection.svelte';
import BanCharacterSetSettings from 'src/lib/Setting/Pages/Advanced/BanCharacterSetSettings.svelte';
import CustomModelsSettings from 'src/lib/Setting/Pages/Advanced/CustomModelsSettings.svelte';
import StorageInvestigationSettings from 'src/lib/Setting/Pages/Advanced/StorageInvestigationSettings.svelte';
import SettingsExportButtons from 'src/lib/Setting/Pages/Advanced/SettingsExportButtons.svelte';

// Display Settings custom components
import ColorSchemeEditor from 'src/lib/Setting/Pages/Display/ColorSchemeEditor.svelte';
import TextThemeEditor from 'src/lib/Setting/Pages/Display/TextThemeEditor.svelte';
import CustomBackgroundCheck from 'src/lib/Setting/Pages/Display/CustomBackgroundCheck.svelte';
import NotificationCheck from 'src/lib/Setting/Pages/Display/NotificationCheck.svelte';
import ColorToggleCheck from 'src/lib/Setting/Pages/Display/ColorToggleCheck.svelte';

/**
 * Registry of custom components.
 * Add new components here as needed.
 */
export const customComponents: Record<string, Component<any>> = {
    'SeparateParametersSection': SeparateParametersSection,
    'BanCharacterSetSettings': BanCharacterSetSettings,
    'CustomModelsSettings': CustomModelsSettings,
    'StorageInvestigationSettings': StorageInvestigationSettings,
    'SettingsExportButtons': SettingsExportButtons,
    // Display Settings
    'ColorSchemeEditor': ColorSchemeEditor,
    'TextThemeEditor': TextThemeEditor,
    'CustomBackgroundCheck': CustomBackgroundCheck,
    'NotificationCheck': NotificationCheck,
    'ColorToggleCheck': ColorToggleCheck,
} as const;

/**
 * Type-safe component ID type.
 * Will be populated as components are added to the registry.
 */
export type CustomComponentId = keyof typeof customComponents;

/**
 * Props that can be passed to custom components
 */
export interface CustomComponentProps {
    /** Any additional props to pass to the component */
    [key: string]: unknown;
}
