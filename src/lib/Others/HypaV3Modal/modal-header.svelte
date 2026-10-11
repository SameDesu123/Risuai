<script lang="ts">
  import { tick } from "svelte";
  import {
    SearchIcon,
    StarIcon,
    SettingsIcon,
    MoreVerticalIcon,
    BarChartIcon,
    Trash2Icon,
    XIcon,
    SquarePenIcon,
    TagIcon,
  } from "@lucide/svelte";
  import { language } from "src/lang";
  import {
    hypaV3ModalOpen,
    settingsOpen,
    SettingsMenuIndex,
  } from "src/ts/stores.svelte";
  import type { SearchState, BulkEditState, CategoryManagerState, FilterState, UIState } from "./types";

  interface Props {
    searchState: SearchState;
    filterImportant: boolean;
    dropdownOpen: boolean;
    filterSelected: boolean;
    bulkEditState?: BulkEditState;
    categoryManagerState?: CategoryManagerState;
    filterState?: FilterState;
    uiState?: UIState;
    hypaV3Data: any;
    onResetData?: () => Promise<void>;
    onToggleBulkEditMode?: () => void;
    onOpenCategoryManager?: () => void;
  }

  let {
    searchState = $bindable(),
    filterImportant = $bindable(),
    dropdownOpen = $bindable(),
    filterSelected = $bindable(),
    bulkEditState,
    categoryManagerState,
    filterState,
    uiState,
    hypaV3Data,
    onResetData,
    onToggleBulkEditMode,
    onOpenCategoryManager,
  }: Props = $props();


  async function toggleSearch() {
    if (searchState === null) {
      searchState = {
        ref: null,
        query: "",
        results: [],
        currentResultIndex: -1,
        requestedSearchFromIndex: -1,
        isNavigating: false,
      };

      // Focus on search element after it's rendered
      await tick();

      if (searchState.ref) {
        searchState.ref.focus();
      }
    } else {
      searchState = null;
    }
  }

  function toggleFilterImportant() {
    filterImportant = !filterImportant;
  }

  function openGlobalSettings() {
    $hypaV3ModalOpen = false;
    $settingsOpen = true;
    $SettingsMenuIndex = 2; // Other bot settings
  }

  function openDropdown(e: MouseEvent) {
    e.stopPropagation();
    dropdownOpen = true;
  }

  function toggleFilterSelected() {
    filterSelected = !filterSelected;
  }

  async function resetData() {
    if (onResetData) {
      await onResetData();
    }
  }

  function closeModal() {
    $hypaV3ModalOpen = false;
  }

  function toggleBulkEditMode() {
    if (onToggleBulkEditMode) {
      onToggleBulkEditMode();
    }
  }

  function openCategoryManager() {
    if (onOpenCategoryManager) {
      onOpenCategoryManager();
    }
  }
</script>

<div class="flex items-center justify-between mb-2 sm:mb-4">
  <!-- Modal Title -->
  <h1 class="text-lg font-semibold sm:text-2xl text-zinc-300">
    {language.hypaV3Modal.titleLabel}
  </h1>

  <!-- Buttons Container -->
  <div class="flex items-center gap-2">
    <!-- Open Search Button -->
    <button
      class="p-2 transition-colors text-zinc-400 hover:text-zinc-200"
      onclick={async () => await toggleSearch()}
      aria-label={language.search}
    >
      <SearchIcon class="w-6 h-6" />
    </button>

    <!-- Filter Important Summary Button -->
    <button
      class="p-2 transition-colors {filterState?.showImportantOnly
        ? 'text-yellow-400 hover:text-yellow-300'
        : 'text-zinc-400 hover:text-zinc-200'}"
      onclick={toggleFilterImportant}
      aria-label={language.hypaV3Modal.filterImportantLabel}
      aria-pressed={!!filterState?.showImportantOnly}
    >
      <StarIcon class="w-6 h-6" />
    </button>

    <!-- Bulk Edit Mode Button -->
    {#if bulkEditState}
      <button
        class="p-2 transition-colors {bulkEditState.isEnabled
          ? 'text-blue-400 hover:text-blue-300'
          : 'text-zinc-400 hover:text-zinc-200'}"
        onclick={toggleBulkEditMode}
        aria-label={language.hypaV3Modal.bulkEditLabel}
        aria-pressed={bulkEditState.isEnabled}
      >
        <SquarePenIcon class="w-6 h-6" />
      </button>
    {/if}

    <!-- Category Manager Button -->
    {#if categoryManagerState}
      <button
        class="p-2 text-zinc-400 hover:text-zinc-200 transition-colors"
        onclick={openCategoryManager}
        aria-label={language.hypaV3Modal.categoryManager}
      >
        <TagIcon class="w-6 h-6" />
      </button>
    {/if}

    <!-- Open Global Settings Button -->
    <button
      class="p-2 transition-colors text-zinc-400 hover:text-zinc-200"
      onclick={openGlobalSettings}
      aria-label={language.settings}
    >
      <SettingsIcon class="w-6 h-6" />
    </button>

    <!-- Open Dropdown Button -->
    <div class="relative">
      <button
        class="p-2 transition-colors text-zinc-400 hover:text-zinc-200"
        onclick={openDropdown}
        aria-label={language.options}
        aria-expanded={dropdownOpen}
      >
        <MoreVerticalIcon class="w-6 h-6" />
      </button>

      {#if dropdownOpen}
        <div
          class="absolute right-0 z-10 p-2 mt-1 border rounded-md shadow-lg border-zinc-700 bg-zinc-800"
        >
          <!-- Buttons Container -->
          <div class="flex items-center gap-2">
            <!-- Filter Selected Summary Button -->
            <button
              class="p-2 transition-colors {filterSelected
                ? 'text-blue-400 hover:text-blue-300'
                : 'text-zinc-400 hover:text-zinc-200'}"
              onclick={toggleFilterSelected}
              aria-label={language.hypaV3Modal.filterSelectedLabel}
              aria-pressed={filterSelected}
            >
              <BarChartIcon class="w-6 h-6" />
            </button>

            <!-- Reset Data Button -->
            <button
              class="p-2 transition-colors text-zinc-400 hover:text-rose-300"
              onclick={async () => await resetData()}
              aria-label={language.reset}
            >
              <Trash2Icon class="w-6 h-6" />
            </button>
          </div>
        </div>
      {/if}
    </div>

    <!-- Close Modal Button -->
    <button
      class="p-2 transition-colors text-zinc-400 hover:text-zinc-200"
      onclick={closeModal}
      aria-label={language.close}
    >
      <XIcon class="w-6 h-6" />
    </button>
  </div>
</div>
