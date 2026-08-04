(function () {
  'use strict';

  var root = document.querySelector('[data-theme-editor]');
  if (!root) return;

  function copyValue(name, fallback) {
    var value = root.getAttribute('data-theme-editor-copy-' + name);
    return value === null || value === '' ? fallback : value;
  }

  function formatCopy(template, values) {
    return String(template || '').replace(/\{([a-zA-Z0-9_]+)\}/g, function (_match, key) {
      return values && values[key] !== undefined ? String(values[key]) : _match;
    });
  }

  var copy = {
    discardUnsaved: copyValue('discard-unsaved', 'Discard unsaved changes in this selection?'),
    editContent: copyValue('edit-content', 'Edit content'),
    saving: copyValue('saving', 'Saving…'),
    changesFailed: copyValue('changes-failed', 'Changes could not be saved.'),
    changesSaved: copyValue('changes-saved', 'Changes saved'),
    saveChanges: copyValue('save-changes', 'Save changes'),
    schemaNoSettings: copyValue('schema-no-settings', 'This section has no schema settings.'),
    schemaNoBinding: copyValue('schema-no-binding', 'No template section binds this block, so there is nothing to save these to.'),
    empty: copyValue('empty', 'Empty'),
    noStoredValue: copyValue('no-stored-value', 'No stored value backs this setting yet.'),
    savingOrder: copyValue('saving-order', 'Saving order…'),
    orderSaved: copyValue('order-saved', 'Order saved'),
    orderFailed: copyValue('order-failed', 'Could not save order'),
    bindingFailed: copyValue('binding-failed', 'Could not resolve this binding.'),
    show: copyValue('show', 'Show'),
    hide: copyValue('hide', 'Hide'),
    visibilityTitle: copyValue('visibility-title', '{action} the {section} section in every page using this template'),
    noScalarValues: copyValue('no-scalar-values', 'This selection has no scalar values to edit yet.'),
    pageSettings: copyValue('page-settings', 'Page settings'),
    block: copyValue('block', 'Block {number}'),
    pageValues: copyValue('page-values', 'Page values'),
    blockSettings: copyValue('block-settings', 'Block settings'),
    itemGroup: copyValue('item-group', '{key} · item {number}'),
    pagePointers: copyValue('page-pointers', 'Page pointers'),
    system: copyValue('system', 'system'),
    pointer: copyValue('pointer', 'pointer'),
    attribute: copyValue('attribute', 'attribute'),
    valueFallback: copyValue('value-fallback', 'Value'),
    someoneElse: copyValue('someone-else', 'Someone else'),
    editingThis: copyValue('editing-this', '{names} is editing this'),
    idle: copyValue('idle', ' (idle)'),
    you: copyValue('you', ' (you)')
  };

  function localizeServerMessage(message) {
    if (message === 'Changes saved') return copy.changesSaved;
    if (message === 'Changes could not be saved.') return copy.changesFailed;
    return message;
  }

  var editorAction = root.getAttribute('data-editor-action');
  var stateSource = root.querySelector('[data-theme-editor-state]');
  var form = root.querySelector('[data-theme-editor-form]');
  var fieldsHost = root.querySelector('[data-theme-editor-fields]');
  var fieldsScroll = root.querySelector('[data-theme-editor-fields-scroll]');
  var selectedLabel = root.querySelector('[data-theme-editor-selected-label]');
  var selectedType = root.querySelector('[data-theme-editor-selected-type]');
  var selectedBlockInput = root.querySelector('[data-theme-editor-selected-block]');
  var selectedSectionInput = root.querySelector('[data-theme-editor-selected-section]');
  var panelViewport = root.querySelector('[data-theme-editor-panel-viewport]');
  var panelTrack = root.querySelector('[data-theme-editor-panel-track]');
  var listPanel = root.querySelector('[data-theme-editor-list-panel]');
  var settingsPanel = root.querySelector('[data-theme-editor-settings-panel]');
  var listHeading = root.querySelector('[data-theme-editor-list-heading]');
  var saveButton = root.querySelector('[data-theme-editor-save-button]');
  var saveStatus = root.querySelector('[data-theme-editor-save-status]');
  var preview = root.querySelector('[data-theme-editor-preview]');
  var sectionList = root.querySelector('[data-theme-editor-section-list]');
  var orderStatus = root.querySelector('[data-theme-editor-order-status]');
  var publishForm = root.querySelector('[data-theme-editor-publish]');
  var pendingCount = root.querySelector('[data-theme-editor-pending-count]');
  if (!editorAction || !stateSource || !form || !fieldsHost || !selectedLabel || !selectedType
    || !selectedBlockInput || !selectedSectionInput || !panelViewport || !panelTrack
    || !listPanel || !settingsPanel || !listHeading) return;

  var state;
  try {
    state = JSON.parse(stateSource.value);
  } catch (_error) {
    return;
  }
  if (!isRecord(state) || !isRecord(state.lect) || !positiveInteger(state.pageId)) return;

  state.languages = Array.isArray(state.languages)
    ? state.languages.filter(function (language) { return typeof language === 'string' && language; })
    : [];
  state.language = typeof state.language === 'string' && state.language
    ? state.language
    : state.languages[0] || 'mis';
  state.themeId = typeof state.themeId === 'string' ? state.themeId : '';
  state.templateId = typeof state.templateId === 'string' ? state.templateId : '';
  state.canEdit = state.canEdit === true;
  // The template's sections, in the order it renders them. The list is drawn
  // from these, so composing a panel here has to read the same list.
  state.sections = Array.isArray(state.sections)
    ? state.sections.filter(isRecord).map(function (entry) {
      return {
        key: stringValue(entry.key),
        label: stringValue(entry.label),
        type: stringValue(entry.type),
        blockIndex: blockFromValue(
          entry.blockIndex === null || entry.blockIndex === undefined
            ? ''
            : String(entry.blockIndex)
        )
      };
    })
    : [];

  var dirty = false;
  var saving = false;
  var previewTimer = 0;
  var bindingTimer = 0;
  var inlineEdit = null;
  // Moving through sections quickly can leave more than one bindings request
  // in flight; only the newest may draw. Otherwise a slow earlier answer would
  // land last and show the wrong section's bindings.
  var schemaRequest = 0;
  var settingsMode = root.getAttribute('data-settings-mode') === 'schema' ? 'schema' : 'values';
  var inspectorView = blockFromValue(selectedBlockInput.value) === null
    && !selectedSectionInput.value
    ? 'list'
    : 'settings';

  setInspectorView(inspectorView, false, false);
  if (sectionList && state.canEdit) setupSectionOrdering();
  window.addEventListener('resize', syncPanelHeight);

  form.addEventListener('input', function (event) {
    var target = event.target;
    if (!target || typeof target.name !== 'string') return;
    if (target.name.indexOf('field:/') === 0) {
      dirty = true;
      clearSaveStatus();
      // The preview node is already showing keystrokes made inside it. A full
      // body render here would replace that node and lose the caret; blur does
      // one canonical Liquid render after inline editing finishes.
      if (!inlineEdit || inlineEdit.fieldName !== target.name) schedulePreviewRender();
      return;
    }
    if (target.name.indexOf('setting:') === 0) {
      dirty = true;
      clearSaveStatus();
      // The hint under a binding is what that binding resolves to, so it has
      // to follow the binding rather than the value it started out showing.
      scheduleBindingResolve(target);
    }
  });
  form.addEventListener('submit', function (event) {
    if (typeof window.fetch !== 'function' || !saveButton || !saveStatus) {
      dirty = false;
      return;
    }
    event.preventDefault();
    saveChanges();
  });

  // Only intercept when the frame can be redrawn here; otherwise the plain
  // POST and its reload remain the way a toggle takes effect.
  root.addEventListener('submit', function (event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    var visibility = target.closest('[data-theme-editor-visibility]');
    if (!visibility || !root.contains(visibility)) return;
    if (typeof window.fetch !== 'function' || !frameRenderer()) return;
    event.preventDefault();
    toggleSectionVisibility(visibility);
  });

  // The binding is there to be copied, so put the caret through the whole of
  // it rather than making the reader drag-select Liquid braces.
  root.addEventListener('focusin', function (event) {
    var target = event.target;
    if (target && target.hasAttribute && target.hasAttribute('data-theme-editor-binding')) {
      target.select();
    }
  });

  root.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') return;

    var close = target.closest('[data-theme-editor-close]');
    if (close && root.contains(close)) {
      event.preventDefault();
      setInspectorView('list', true, true);
      return;
    }

    var mode = target.closest('[data-theme-editor-mode]');
    if (mode && root.contains(mode)) {
      var wanted = mode.getAttribute('data-theme-editor-mode');
      event.preventDefault();
      // Both panels are on the page, so the switch is local. The rendered
      // schema panel describes whichever selection the server drew it for,
      // though, so moving here means re-reading it for the current one.
      if (wanted === 'schema' && !schemaPanelMatchesSelection()) {
        loadSchemaPanel(mode.href);
        return;
      }
      setSettingsMode(wanted, mode.href);
      return;
    }

    var link = target.closest('[data-theme-editor-focus]');
    if (!link || !root.contains(link)) return;
    event.preventDefault();
    focusTarget(
      blockFromValue(link.getAttribute('data-block')),
      link.getAttribute('data-section') || '',
      link.href,
      true,
      'settings'
    );
  });

  // Choosing a page, template, or language loads it straight away. The submit
  // button stays in the markup for the no-script path and is hidden only once
  // this takes over, so the form is never left with no way to submit.
  var loadForm = root.querySelector('[data-theme-editor-load]');
  if (loadForm) {
    var pageSelect = loadForm.querySelector('[data-theme-editor-page-select]');
    var pageCombobox = loadForm.querySelector('[data-theme-editor-page-combobox]');
    var syncPageCombobox = pageSelect && pageCombobox
      ? setupPageCombobox(pageSelect, pageCombobox)
      : function () {};

    loadForm.querySelectorAll('select').forEach(function (select) {
      select.setAttribute('data-loaded-value', select.value);
    });
    loadForm.addEventListener('change', function (event) {
      var select = event.target;
      if (!select || select.tagName !== 'SELECT' || !loadForm.contains(select)) return;
      if (dirty && !window.confirm(copy.discardUnsaved)) {
        // Leaving the new choice showing would describe a page that was never
        // loaded, so put the selector back to what is on screen.
        select.value = select.getAttribute('data-loaded-value') || select.value;
        syncPageCombobox();
        return;
      }
      dirty = false;
      loadForm.submit();
    });
    var loadButton = loadForm.querySelector('[data-theme-editor-load-button]');
    if (loadButton) loadButton.hidden = true;
  }

  function setupPageCombobox(select, combobox) {
    var search = combobox.querySelector('[data-theme-editor-page-search]');
    var results = combobox.querySelector('[data-theme-editor-page-results]');
    var empty = combobox.querySelector('[data-theme-editor-page-empty]');
    var toggle = combobox.querySelector('[data-theme-editor-page-toggle]');
    if (!search || !results || !empty || !toggle) return function () {};

    var options = Array.prototype.map.call(select.options, function (source, index) {
      var label = source.label || source.text || source.textContent || '';
      var option = document.createElement('button');
      option.type = 'button';
      option.id = 'theme_editor_page_option_' + index;
      option.setAttribute('role', 'option');
      option.setAttribute('data-theme-editor-page-option', '');
      option.setAttribute('data-page-id', source.value);
      option.setAttribute(
        'data-page-search',
        (label + ' #' + source.value).toLocaleLowerCase()
      );
      option.className = 'block w-full truncate px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50';
      option.textContent = label;
      results.insertBefore(option, empty);
      return option;
    });
    var activeOption = null;

    select.hidden = true;
    combobox.hidden = false;
    sync();

    function selectedSource() {
      var selectedValue = select.value;
      return Array.prototype.find.call(select.options, function (option) {
        return option.value === selectedValue;
      }) || select.options[0] || null;
    }

    function sync() {
      var selected = selectedSource();
      search.value = selected
        ? selected.label || selected.text || selected.textContent || ''
        : '';
      options.forEach(function (option) {
        var isSelected = !!selected && option.getAttribute('data-page-id') === selected.value;
        option.setAttribute('aria-selected', isSelected ? 'true' : 'false');
        option.classList.toggle('bg-indigo-50', isSelected);
        option.classList.toggle('font-semibold', isSelected);
        option.classList.toggle('text-indigo-700', isSelected);
        option.classList.toggle('text-gray-700', !isSelected);
      });
      closeResults();
    }

    function visibleOptions() {
      return options.filter(function (option) { return !option.hidden; });
    }

    function filterOptions(query) {
      var needle = query.trim().toLocaleLowerCase();
      var visibleCount = 0;
      options.forEach(function (option) {
        var visible = !needle
          || (option.getAttribute('data-page-search') || '').indexOf(needle) !== -1;
        option.hidden = !visible;
        if (visible) visibleCount += 1;
      });
      empty.classList.toggle('hidden', visibleCount > 0);
      setActiveOption(null);
    }

    function openResults(query) {
      filterOptions(query || '');
      results.classList.remove('hidden');
      search.setAttribute('aria-expanded', 'true');
    }

    function closeResults() {
      results.classList.add('hidden');
      search.setAttribute('aria-expanded', 'false');
      setActiveOption(null);
    }

    function setActiveOption(option) {
      if (activeOption) activeOption.classList.remove('bg-gray-100');
      activeOption = option;
      if (!activeOption) {
        search.removeAttribute('aria-activedescendant');
        return;
      }
      activeOption.classList.add('bg-gray-100');
      search.setAttribute('aria-activedescendant', activeOption.id);
      if (typeof activeOption.scrollIntoView === 'function') {
        activeOption.scrollIntoView({ block: 'nearest' });
      }
    }

    function moveActive(step) {
      var visible = visibleOptions();
      if (!visible.length) return;
      var index = activeOption ? visible.indexOf(activeOption) : -1;
      index = index < 0
        ? (step > 0 ? 0 : visible.length - 1)
        : (index + step + visible.length) % visible.length;
      setActiveOption(visible[index]);
    }

    function selectOption(option) {
      var id = option.getAttribute('data-page-id') || '';
      if (!id) return;
      select.value = id;
      sync();
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    search.addEventListener('focus', function () {
      openResults('');
      search.select();
    });
    search.addEventListener('click', function () {
      if (results.classList.contains('hidden')) openResults('');
    });
    search.addEventListener('input', function () {
      openResults(search.value);
    });
    search.addEventListener('keydown', function (event) {
      if (event.key === 'Tab') {
        closeResults();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        sync();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (results.classList.contains('hidden')) openResults(search.value);
        moveActive(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (event.key !== 'Enter') return;
      var option = activeOption || visibleOptions()[0];
      if (!option) return;
      event.preventDefault();
      selectOption(option);
    });
    toggle.addEventListener('click', function () {
      if (results.classList.contains('hidden')) {
        search.focus();
        openResults('');
        search.select();
      } else {
        closeResults();
      }
    });
    results.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      var option = target.closest('[data-theme-editor-page-option]');
      if (option && results.contains(option)) selectOption(option);
    });
    document.addEventListener('click', function (event) {
      if (!combobox.contains(event.target)) closeResults();
    });

    return sync;
  }

  if (preview) {
    preview.addEventListener('load', bindPreview);
    bindPreview();
  }

  // The frame draws itself after fetching its data, so the selection has to be
  // reapplied once there is markup to apply it to.
  window.addEventListener('message', function (event) {
    if (event.origin !== window.location.origin) return;
    if (!isRecord(event.data) || event.data.type !== 'theme-editor-preview-ready') return;
    bindPreview();
    selectBlockInPreview(blockFromValue(selectedBlockInput.value));
    // The server's first paint of the hints reads stored values; now that the
    // renderer is up, replace them with what the bindings actually resolve to.
    resolveAllBindings();
  });

  window.addEventListener('popstate', function () {
    var params = new URL(window.location.href).searchParams;
    var historyView = window.history.state && window.history.state.themeEditorView;
    var view = historyView === 'settings' || historyView === 'list'
      ? historyView
      : params.has('block') || params.has('section') ? 'settings' : 'list';
    focusTarget(
      blockFromValue(params.get('block')),
      params.get('section') || '',
      window.location.href,
      false,
      view
    );
  });

  function bindPreview() {
    if (!preview) return;
    try {
      var previewDocument = preview.contentDocument;
      if (!previewDocument || !previewDocument.documentElement) return;
      prepareInlineFields(previewDocument);
      if (previewDocument.documentElement.hasAttribute('data-theme-editor-bound')) {
        selectBlockInPreview(blockFromValue(selectedBlockInput.value));
        return;
      }
      previewDocument.documentElement.setAttribute('data-theme-editor-bound', '1');
      previewDocument.addEventListener('click', function (event) {
        var target = event.target;
        if (!target || typeof target.closest !== 'function') return;

        var editable = target.closest('[data-theme-editor-field]');
        if (editable && beginInlineEdit(editable)) {
          // A contenteditable element's native click and drag behavior places
          // the caret or selects text. Do not cancel or replace that selection.
          // Editable links are the exception: suppress navigation and preserve
          // the click position explicitly.
          if (target.closest('a[href]')) {
            placeCaretFromClick(editable, event);
            event.preventDefault();
          }
          return;
        }

        var link = target.closest('.theme-editor-select');
        if (link) {
          var wrapper = link.closest('[data-theme-editor-block]');
          if (!wrapper) return;
          // As in the list, schema mode needs the server to compose the panel.
          if (settingsMode === 'schema') return;
          event.preventDefault();
          focusTarget(
            blockFromValue(wrapper.getAttribute('data-theme-editor-block')),
            '',
            link.href,
            true,
            'settings'
          );
          return;
        }

        if (target.closest('[data-theme-editor-block]')) return;
        if (isInteractiveTarget(target)) return;
        if (blockFromValue(selectedBlockInput.value) === null && !selectedSectionInput.value) return;

        focusTarget(null, '', editorHref(null, ''), true, 'list');
      });
      previewDocument.addEventListener('input', function (event) {
        var target = event.target;
        if (!target || !target.hasAttribute || !target.hasAttribute('data-theme-editor-field')) return;
        syncInlineField(target);
      });
      previewDocument.addEventListener('focusout', function (event) {
        if (inlineEdit && event.target === inlineEdit.element) finishInlineEdit(false);
      });
      previewDocument.addEventListener('keydown', function (event) {
        var target = event.target;
        if (!inlineEdit || target !== inlineEdit.element) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          finishInlineEdit(true);
          if (typeof target.blur === 'function') target.blur();
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          if (typeof target.blur === 'function') target.blur();
          if (inlineEdit && target === inlineEdit.element) finishInlineEdit(false);
        }
      });
      previewDocument.addEventListener('paste', function (event) {
        var target = event.target;
        if (!inlineEdit || target !== inlineEdit.element || !event.clipboardData) return;
        event.preventDefault();
        insertPlainText(previewDocument, event.clipboardData.getData('text/plain'));
        syncInlineField(target);
      });
      selectBlockInPreview(blockFromValue(selectedBlockInput.value));
    } catch (_error) {
      // If preview hosting moves to another origin, its target="_top" links
      // remain the selection fallback.
    }
  }

  function isInteractiveTarget(target) {
    return !!target.closest(
      'a,button,input,select,textarea,label,summary,details'
    );
  }

  function prepareInlineFields(previewDocument) {
    previewDocument.querySelectorAll('[data-theme-editor-field]').forEach(function (element) {
      var fieldName = element.getAttribute('data-theme-editor-field') || '';
      if (!state.canEdit || fieldName.indexOf('field:/') !== 0) {
        element.removeAttribute('contenteditable');
        element.removeAttribute('role');
        element.removeAttribute('aria-label');
        return;
      }
      element.setAttribute('contenteditable', 'plaintext-only');
      element.setAttribute('role', 'textbox');
      element.setAttribute('aria-label', copy.editContent);
      element.setAttribute('spellcheck', 'true');
    });
  }

  function beginInlineEdit(element) {
    if (!state.canEdit) return false;
    var fieldName = element.getAttribute('data-theme-editor-field') || '';
    if (fieldName.indexOf('field:/') !== 0) return false;
    // Once editing has started, later clicks belong to the browser's native
    // selection behavior. Reinitializing here would also make Escape restore
    // the value from the most recent click instead of the original value.
    if (inlineEdit && inlineEdit.element === element) return true;
    var block = blockFromFieldName(fieldName);

    if (settingsMode !== 'values') setSettingsMode('values', editorHref(block, ''));
    if (blockFromValue(selectedBlockInput.value) !== block) {
      focusTarget(block, '', editorHref(block, ''), true, 'settings');
      // A pending save or a cancelled discard confirmation can keep the old
      // selection. In that case there is no matching input to write safely.
      if (blockFromValue(selectedBlockInput.value) !== block) return false;
    } else {
      setInspectorView('settings', true, false);
    }

    var input = namedFormField(fieldName);
    if (!input || input.readOnly || input.disabled) return false;
    inlineEdit = {
      element: element,
      fieldName: fieldName,
      input: input,
      originalText: element.textContent || '',
      originalValue: input.value,
      wasDirty: dirty
    };
    element.setAttribute('data-theme-editor-inline-active', '');
    if (typeof element.focus === 'function') element.focus({ preventScroll: true });
    revealInlineInput(input);
    return true;
  }

  function revealInlineInput(input) {
    if (!fieldsScroll || !fieldsScroll.contains(input)) return;
    try {
      var scrollRect = fieldsScroll.getBoundingClientRect();
      var inputRect = input.getBoundingClientRect();
      var inset = 8;
      if (inputRect.top < scrollRect.top + inset) {
        fieldsScroll.scrollTop += inputRect.top - scrollRect.top - inset;
      } else if (inputRect.bottom > scrollRect.bottom - inset) {
        fieldsScroll.scrollTop += inputRect.bottom - scrollRect.bottom + inset;
      }
    } catch (_error) {
      // The preview remains editable when geometry is unavailable.
    }
  }

  function syncInlineField(element) {
    if (!inlineEdit || inlineEdit.element !== element) {
      if (!beginInlineEdit(element)) return;
    }
    var value = (element.textContent || '').replace(/\u00a0/g, ' ');
    inlineEdit.input.value = value;
    inlineEdit.input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function finishInlineEdit(cancelled) {
    if (!inlineEdit) return;
    var editing = inlineEdit;
    inlineEdit = null;
    editing.element.removeAttribute('data-theme-editor-inline-active');

    if (cancelled) {
      editing.element.textContent = editing.originalText;
      editing.input.value = editing.originalValue;
      dirty = editing.wasDirty;
    }

    // Re-run the real template once so escaping, conditionals, and surrounding
    // markup agree with what will be saved. This is deliberately not debounced:
    // the edit has ended and replacing the preview node can no longer lose its
    // caret.
    renderPreview({ lect: state.lect, fields: new FormData(form) });
  }

  function blockFromFieldName(fieldName) {
    var match = /^field:\/_blocks\/(\d+)\//.exec(fieldName);
    return match ? blockFromValue(match[1]) : null;
  }

  function namedFormField(name) {
    var found = null;
    form.querySelectorAll('[name]').forEach(function (field) {
      if (!found && field.name === name) found = field;
    });
    return found;
  }

  function placeCaretFromClick(element, event) {
    try {
      var previewDocument = element.ownerDocument;
      var range = null;
      if (typeof previewDocument.caretPositionFromPoint === 'function') {
        var position = previewDocument.caretPositionFromPoint(event.clientX, event.clientY);
        if (position) {
          range = previewDocument.createRange();
          range.setStart(position.offsetNode, position.offset);
          range.collapse(true);
        }
      } else if (typeof previewDocument.caretRangeFromPoint === 'function') {
        range = previewDocument.caretRangeFromPoint(event.clientX, event.clientY);
      }
      if (!range || (range.startContainer !== element && !element.contains(range.startContainer))) {
        return false;
      }
      var selection = previewDocument.getSelection();
      if (!selection) return false;
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function insertPlainText(previewDocument, value) {
    var text = String(value || '').replace(/\s*\r?\n\s*/g, ' ');
    var selection = previewDocument.getSelection && previewDocument.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    var range = selection.getRangeAt(0);
    range.deleteContents();
    var node = previewDocument.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  async function saveChanges() {
    if (saving || !saveButton || !saveStatus) return;
    saving = true;
    saveButton.disabled = true;
    saveButton.textContent = copy.saving;
    form.setAttribute('aria-busy', 'true');
    clearSaveStatus();

    try {
      var response = await window.fetch(form.action, {
        method: 'POST',
        body: new FormData(form),
        headers: {
          accept: 'application/json',
          'x-requested-with': 'XMLHttpRequest'
        },
        credentials: 'same-origin'
      });
      var payload = await responsePayload(response);
      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        throw new Error(
          isRecord(payload) && typeof payload.message === 'string'
            ? payload.message
            : copy.changesFailed
        );
      }

      if (isRecord(payload.lect)) {
        state.lect = payload.lect;
        stateSource.value = JSON.stringify(state);
      }
      if (isRecord(payload.settingOverrides)) {
        renderPreview({ settingOverrides: payload.settingOverrides });
      }
      dirty = false;
      showSaveStatus(
        typeof payload.message === 'string' ? localizeServerMessage(payload.message) : copy.changesSaved,
        false
      );
      refreshPreview();
    } catch (error) {
      showSaveStatus(
        error instanceof Error && error.message
          ? localizeServerMessage(error.message)
          : copy.changesFailed,
        true
      );
    } finally {
      saving = false;
      saveButton.disabled = false;
      saveButton.textContent = copy.saveChanges;
      form.removeAttribute('aria-busy');
      syncPanelHeight();
    }
  }

  async function responsePayload(response) {
    var contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) return response.json();
    var message = (await response.text()).trim();
    return {
      ok: false,
      message: message && message.charAt(0) !== '<'
        ? message.slice(0, 240)
        : copy.changesFailed
    };
  }

  function showSaveStatus(message, failed) {
    if (!saveStatus) return;
    saveStatus.textContent = message;
    saveStatus.style.backgroundColor = failed ? '#fef2f2' : '#ecfdf5';
    saveStatus.style.color = failed ? '#b91c1c' : '#047857';
    saveStatus.hidden = false;
    syncPanelHeight();
  }

  function clearSaveStatus() {
    if (!saveStatus) return;
    saveStatus.hidden = true;
    saveStatus.textContent = '';
  }

  /**
   * The frame renders itself from the same projection the Worker uses, so a
   * redraw needs no request. Reloading stays the fallback for as long as that
   * asset is unapproved or still starting up.
   */
  /**
   * The rendered schema panel describes one selection. When it no longer
   * matches, loadSchemaPanel() re-reads it rather than the page being loaded
   * again — the bindings come from the theme's own {% schema %}, which this
   * page has no copy of, but the server will hand one over as JSON.
   */
  function schemaPanelMatchesSelection() {
    var modes = root.querySelector('[data-theme-editor-modes]');
    if (!modes) return false;
    return modes.getAttribute('data-schema-block') === (selectedBlockInput.value || '')
      && (modes.getAttribute('data-schema-section') || '') === (selectedSectionInput.value || '');
  }

  /** Where the editor would sit with this selection, for history and fallback. */
  function schemaHref(block, section) {
    var href = editorHref(block, section);
    return href + (href.indexOf('?') === -1 ? '?' : '&') + 'settings=schema';
  }

  /** The endpoint that describes one section's bindings. */
  function sectionSchemaUrl(block, section) {
    var action = form.getAttribute('data-section-schema-action');
    if (!action) return '';
    var query = [
      'theme=' + encodeURIComponent(stringValue(state.themeId)),
      'template=' + encodeURIComponent(stringValue(state.templateId)),
      'page_id=' + encodeURIComponent(String(state.pageId)),
      'language=' + encodeURIComponent(stringValue(state.language)),
      'section=' + encodeURIComponent(stringValue(section))
    ];
    if (block !== null && block !== undefined && block !== '') query.push('block=' + encodeURIComponent(String(block)));
    return action + '?' + query.join('&');
  }

  /**
   * Fetches the current selection's bindings and shows them, leaving the page
   * — and everything unsaved on it — in place. `fallbackHref` is the editor
   * URL for the same selection: a request that cannot be made or understood
   * loads it, so the panel is never silently wrong.
   */
  async function loadSchemaPanel(fallbackHref) {
    var block = selectedBlockInput.value === '' ? null : Number(selectedBlockInput.value);
    var section = selectedSectionInput.value || '';
    var url = sectionSchemaUrl(block, section);
    if (!url) {
      window.location.assign(fallbackHref);
      return;
    }

    var token = ++schemaRequest;
    // Until the answer arrives the panel still shows the previous section's
    // bindings. Disabling it keeps those out of a save and out of reach, so
    // nothing can be typed into — or written from — a panel about to be
    // replaced.
    var panel = root.querySelector('[data-theme-editor-panel="schema"]');
    if (panel) {
      panel.disabled = true;
      panel.setAttribute('aria-busy', 'true');
    }

    try {
      var response = await window.fetch(url, {
        headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
        credentials: 'same-origin'
      });
      var payload = await responsePayload(response);
      if (!response.ok || !isRecord(payload) || payload.ok !== true) throw new Error('unavailable');
      // A later selection has already been asked for; this answer describes a
      // panel nobody is looking at any more.
      if (token !== schemaRequest) return;

      renderSchemaPanel(payload);
      if (panel) panel.removeAttribute('aria-busy');
      // Last, because it is what re-enables the panel now that its contents
      // describe the current selection.
      setSettingsMode('schema', fallbackHref);
    } catch (_error) {
      if (token !== schemaRequest) return;
      window.location.assign(fallbackHref);
    }
  }

  /** Draws the fetched bindings, matching what the server-rendered panel shows. */
  function renderSchemaPanel(payload) {
    var panel = root.querySelector('[data-theme-editor-panel="schema"]');
    var modes = root.querySelector('[data-theme-editor-modes]');
    if (!panel) return;

    var settings = Array.isArray(payload.schemaSettings) ? payload.schemaSettings : [];
    var canEdit = payload.canEditSchema === true;
    panel.replaceChildren();

    var list = element('div', 'space-y-3');
    settings.forEach(function (setting) {
      list.appendChild(renderSchemaField(setting, canEdit));
    });
    panel.appendChild(list);

    if (settings.length === 0) {
      panel.appendChild(element(
        'p',
        'rounded-lg bg-gray-50 px-3 py-4 text-sm text-gray-500',
        copy.schemaNoSettings
      ));
    } else if (!stringValue(payload.section)) {
      panel.appendChild(element(
        'p',
        'mt-3 rounded-lg bg-amber-50 px-3 py-3 text-sm text-amber-700',
        copy.schemaNoBinding
      ));
    }

    var schemaName = root.querySelector('[data-theme-editor-schema-name]');
    if (schemaName) schemaName.textContent = stringValue(payload.schemaName);
    repaintFields();

    // The panel now describes this selection, so the mode links stop asking
    // for it again.
    if (modes) {
      modes.setAttribute('data-schema-block', payload.block === null || payload.block === undefined
        ? ''
        : String(payload.block));
      modes.setAttribute('data-schema-section', stringValue(payload.section));
    }

    // A section the page has no block for has no values to offer.
    var valuesLink = root.querySelector('[data-theme-editor-mode="values"]');
    if (valuesLink) valuesLink.hidden = payload.missingBlock === true;
  }

  function renderSchemaField(setting, canEdit) {
    var label = element('label', 'block min-w-0');
    var heading = element(
      'span',
      'mb-1 flex items-center justify-between gap-2 text-sm font-medium text-gray-700'
    );
    heading.appendChild(element('span', 'truncate', stringValue(setting.label)));
    heading.appendChild(element(
      'span',
      'shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-500',
      stringValue(setting.type)
    ));
    label.appendChild(heading);

    // The control holds the Liquid the template binds — which is what saving
    // here writes. The value it resolves to sits underneath as context, since
    // that is edited in the Values panel instead.
    var control = element(
      'input',
      'block h-10 min-w-0 w-full max-w-full rounded-lg border border-gray-300 px-3 font-mono text-sm'
      + ' focus:border-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500'
    );
    control.name = stringValue(setting.inputName);
    control.value = stringValue(setting.binding);
    control.spellcheck = false;
    control.setAttribute('data-theme-editor-setting', '');
    control.readOnly = !canEdit;
    label.appendChild(control);

    var context = element('span', 'mt-1 block truncate text-xs text-gray-400');
    context.setAttribute('data-theme-editor-setting-value', '');
    context.textContent = stringValue(setting.value)
      || (setting.editable ? copy.empty : copy.noStoredValue);
    label.appendChild(context);
    return label;
  }

  function setSettingsMode(mode, href) {
    settingsMode = mode === 'schema' ? 'schema' : 'values';
    root.setAttribute('data-settings-mode', settingsMode);

    root.querySelectorAll('[data-theme-editor-panel]').forEach(function (panel) {
      var active = panel.getAttribute('data-theme-editor-panel') === settingsMode;
      panel.hidden = !active;
      // A hidden panel stays disabled so its inputs never reach the save
      // payload, where they would compete with the visible panel's.
      panel.disabled = !active;
    });

    root.querySelectorAll('[data-theme-editor-mode]').forEach(function (link) {
      var active = link.getAttribute('data-theme-editor-mode') === settingsMode;
      link.classList.toggle('bg-indigo-50', active);
      link.classList.toggle('text-indigo-700', active);
      link.classList.toggle('text-gray-700', !active);
      link.classList.toggle('hover:bg-gray-50', !active);
      if (active) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });

    var schemaName = root.querySelector('[data-theme-editor-schema-name]');
    if (schemaName) schemaName.hidden = settingsMode !== 'schema';

    // The two panels save different things — one the page's values, the other
    // the template's bindings — so the form has to follow the mode.
    var action = form.getAttribute(
      settingsMode === 'schema' ? 'data-schema-action' : 'data-values-action'
    );
    if (action) form.action = action;

    if (href) window.history.replaceState(window.history.state, '', href);
    syncPanelHeight();
  }

  async function toggleSectionVisibility(form) {
    var button = form.querySelector('[data-theme-editor-visibility-button]');
    if (button) button.disabled = true;
    try {
      var response = await window.fetch(form.action, {
        method: 'POST',
        body: new FormData(form),
        headers: {
          accept: 'application/json',
          'x-requested-with': 'XMLHttpRequest'
        },
        credentials: 'same-origin'
      });
      var payload = await responsePayload(response);
      if (!response.ok || !isRecord(payload) || payload.ok !== true) throw new Error('unavailable');

      var section = form.getAttribute('data-section') || '';
      var hidden = Array.isArray(payload.hidden) ? payload.hidden : [];
      applyVisibility(form, hidden.indexOf(section) !== -1);
      if (button) button.disabled = false;
      markTemplatePending();
      renderPreview({ hidden: hidden });
    } catch (_error) {
      // A failed toggle still has to say so, and the server round-trip is
      // already able to: let the browser submit the form for real.
      if (button) button.disabled = false;
      form.submit();
    }
  }

  function applyVisibility(form, hidden) {
    var row = form.parentElement;
    var value = form.querySelector('[data-theme-editor-visibility-value]');
    var button = form.querySelector('[data-theme-editor-visibility-button]');
    var flag = row && row.querySelector('[data-theme-editor-hidden-flag]');
    var section = form.getAttribute('data-section') || '';

    if (value) value.value = hidden ? '0' : '1';
    if (button) {
      var action = hidden ? copy.show : copy.hide;
      button.textContent = action;
      button.title = formatCopy(copy.visibilityTitle, { action: action, section: section });
    }
    if (flag) flag.hidden = !hidden;
  }

  /** Native drag/drop plus arrow-key movement for the JSON template order. */
  function setupSectionOrdering() {
    var dragging = null;
    var beforeDrag = '';
    var queue = Promise.resolve();

    sectionList.addEventListener('dragstart', function (event) {
      var handle = event.target && event.target.closest
        ? event.target.closest('[data-theme-editor-drag-handle]')
        : null;
      if (!handle) return;
      dragging = handle.closest('[data-theme-editor-section-row]');
      if (!dragging) return;
      beforeDrag = sectionOrder().join('|');
      dragging.classList.add('opacity-50');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', dragging.getAttribute('data-section') || '');
      }
    });

    sectionList.addEventListener('dragover', function (event) {
      if (!dragging) return;
      var target = event.target && event.target.closest
        ? event.target.closest('[data-theme-editor-section-row]')
        : null;
      if (!target || target === dragging || !sectionList.contains(target)) return;
      event.preventDefault();
      var rect = target.getBoundingClientRect();
      var before = event.clientY < rect.top + rect.height / 2;
      sectionList.insertBefore(dragging, before ? target : target.nextSibling);
    });

    sectionList.addEventListener('drop', function (event) {
      if (dragging) event.preventDefault();
    });

    sectionList.addEventListener('dragend', function () {
      if (!dragging) return;
      dragging.classList.remove('opacity-50');
      dragging = null;
      var order = sectionOrder();
      if (order.join('|') !== beforeDrag) enqueue(order);
    });

    sectionList.addEventListener('keydown', function (event) {
      var handle = event.target && event.target.closest
        ? event.target.closest('[data-theme-editor-drag-handle]')
        : null;
      if (!handle || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      var row = handle.closest('[data-theme-editor-section-row]');
      var sibling = event.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling;
      if (!row || !sibling || !sibling.hasAttribute('data-theme-editor-section-row')) return;
      event.preventDefault();
      if (event.key === 'ArrowUp') sectionList.insertBefore(row, sibling);
      else sectionList.insertBefore(sibling, row);
      handle.focus();
      enqueue(sectionOrder());
    });

    function enqueue(order) {
      if (orderStatus) orderStatus.textContent = copy.savingOrder;
      queue = queue.then(function () { return persist(order); });
    }

    async function persist(order) {
      var action = sectionList.getAttribute('data-order-action') || '';
      if (!action || typeof window.fetch !== 'function') {
        window.location.reload();
        return;
      }
      var body = new FormData();
      body.set('theme', state.themeId);
      body.set('template', state.templateId);
      body.set('order', JSON.stringify(order));
      try {
        var response = await window.fetch(action, {
          method: 'POST',
          body: body,
          headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
          credentials: 'same-origin'
        });
        var payload = await responsePayload(response);
        if (!response.ok || !isRecord(payload) || payload.ok !== true) throw new Error('unavailable');
        var saved = Array.isArray(payload.order) ? payload.order : order;
        state.sections.sort(function (left, right) {
          return saved.indexOf(left.key) - saved.indexOf(right.key);
        });
        if (orderStatus) orderStatus.textContent = copy.orderSaved;
        markTemplatePending();
        renderPreview({ order: saved, added: isRecord(payload.added) ? payload.added : {} });
      } catch (_error) {
        if (orderStatus) orderStatus.textContent = copy.orderFailed;
        window.location.reload();
      }
    }

    function sectionOrder() {
      return Array.prototype.map.call(
        sectionList.querySelectorAll('[data-theme-editor-section-row]'),
        function (row) { return row.getAttribute('data-section') || ''; }
      ).filter(Boolean);
    }
  }

  function markTemplatePending() {
    if (!publishForm) return;
    publishForm.hidden = false;
    if (!pendingCount) return;
    var count = Number.parseInt(pendingCount.textContent || '0', 10);
    pendingCount.textContent = String(Number.isInteger(count) && count > 0 ? count : 1);
  }

  /**
   * Asks the preview for what a binding resolves to on the page being shown.
   * The preview owns the render context, so this is the value the section
   * would receive rather than a second reading of the stored data.
   */
  function resolveBinding(input) {
    var api = frameRenderer();
    if (!api || typeof api.resolve !== 'function') return;
    var hint = input.parentElement
      && input.parentElement.querySelector('[data-theme-editor-setting-value]');
    if (!hint) return;
    var binding = input.value;
    api.resolve(binding).then(function (value) {
      // A slower answer for a binding that has since been edited must not
      // overwrite the newer one.
      if (input.value !== binding) return;
      var text = typeof value === 'string' ? value.trim() : '';
      hint.textContent = text || copy.empty;
    }).catch(function () {
      hint.textContent = copy.bindingFailed;
    });
  }

  function scheduleBindingResolve(input) {
    window.clearTimeout(bindingTimer);
    bindingTimer = window.setTimeout(function () { resolveBinding(input); }, 250);
  }

  function resolveAllBindings() {
    root.querySelectorAll('[data-theme-editor-setting]').forEach(resolveBinding);
  }

  function frameRenderer() {
    // The renderer runs here, in the editor page, because the host strips
    // scripts out of the preview document itself.
    var api = window.themeEditorPreview;
    return api && typeof api.render === 'function' ? api : null;
  }

  function renderPreview(update) {
    var api = frameRenderer();
    if (!api) return false;
    try {
      var result = api.render(update);
      if (result && typeof result.then === 'function') {
        result.then(bindPreview).catch(reloadPreview);
      }
      return true;
    } catch (_error) {
      return false;
    }
  }

  function refreshPreview() {
    if (renderPreview({ lect: state.lect })) return;
    reloadPreview();
  }

  /**
   * Typing repaints the frame directly. Coalesced because a keystroke costs a
   * full template render, and a render mid-keystroke is wasted work.
   */
  function schedulePreviewRender() {
    if (!frameRenderer()) return;
    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(function () {
      renderPreview({ lect: state.lect, fields: new FormData(form) });
    }, 250);
  }

  function reloadPreview() {
    if (!preview) return;
    try {
      if (preview.contentWindow) {
        preview.contentWindow.location.reload();
        return;
      }
    } catch (_error) {
      // Reassigning src remains available if iframe access becomes cross-origin.
    }
    preview.src = preview.src;
  }

  function setInspectorView(view, animate, focusTarget) {
    inspectorView = view === 'settings' ? 'settings' : 'list';
    var settingsVisible = inspectorView === 'settings';
    var reducedMotion = window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    panelTrack.style.transition = animate && !reducedMotion
      ? 'transform 220ms ease'
      : 'none';
    panelViewport.style.transition = animate && !reducedMotion
      ? 'height 200ms ease'
      : 'none';
    panelTrack.style.transform = settingsVisible
      ? 'translateX(-50%)'
      : 'translateX(0)';
    listPanel.setAttribute('aria-hidden', settingsVisible ? 'true' : 'false');
    settingsPanel.setAttribute('aria-hidden', settingsVisible ? 'false' : 'true');
    listPanel.inert = settingsVisible;
    settingsPanel.inert = !settingsVisible;

    window.requestAnimationFrame(function () {
      syncPanelHeight();
      if (!focusTarget) return;
      if (settingsVisible) {
        focusWithoutScroll(selectedLabel);
        return;
      }
      var activeLink = listPanel.querySelector('[data-theme-editor-focus][aria-current="true"]');
      focusWithoutScroll(activeLink || listHeading);
    });
  }

  function syncPanelHeight() {
    var activePanel = inspectorView === 'settings' ? settingsPanel : listPanel;
    panelViewport.style.height = activePanel.scrollHeight + 'px';
  }

  function focusWithoutScroll(target) {
    if (!target || typeof target.focus !== 'function') return;
    try {
      target.focus({ preventScroll: true });
    } catch (_error) {
      target.focus();
    }
  }

  function focusTarget(block, section, fallbackHref, pushHistory, nextView) {
    if (saving) return;
    if (dirty && !window.confirm(copy.discardUnsaved)) return;
    dirty = false;
    clearSaveStatus();

    try {
      var panel = composePanel(block, section);
      renderPanel(panel);
      updateNavigation(panel.selectedBlock, panel.selectedSection);
      syncSettingsModes(panel.selectedBlock, panel.selectedSection);
      selectBlockInPreview(panel.selectedBlock, true);
      if (fieldsScroll) fieldsScroll.scrollTop = 0;
      setInspectorView(nextView, true, true);

      // The bindings panel belongs to the section, so a new selection needs a
      // new one. It is fetched — never navigated to — while already in Schema
      // mode, and for a section the page has no block for, which has no values
      // to show and so opens on its bindings.
      if (settingsMode === 'schema' || panel.missingBlock) {
        loadSchemaPanel(schemaHref(panel.selectedBlock, panel.selectedSection));
      }

      if (pushHistory) {
        window.history.pushState(
          {
            themeEditorBlock: panel.selectedBlock,
            themeEditorSection: panel.selectedSection,
            themeEditorView: inspectorView
          },
          '',
          panel.editorHref
        );
      }
    } catch (_error) {
      window.location.assign(fallbackHref);
    }
  }

  /**
   * Template section + page lect + selected block → the inspector view model.
   * The section is what the panel describes; the block is what it can edit,
   * which a page need not have for every section the template declares.
   */
  function composePanel(block, section) {
    var entry = sectionEntry(section, block);
    var selectedBlock = validBlockIndex(state.lect, block)
      ? block
      : entry && validBlockIndex(state.lect, entry.blockIndex) ? entry.blockIndex : null;
    var fields = editorFields(state.lect, state.languages, state.language, selectedBlock);
    return {
      selectedBlock: selectedBlock,
      selectedSection: entry ? entry.key : '',
      selectedLabel: entry
        ? entry.label
        : selectedBlock === null
          ? copy.pageSettings
          : formatCopy(copy.block, { number: selectedBlock + 1 }),
      selectedType: entry
        ? entry.type
        : selectedBlock === null ? '' : scalar(blockAt(state.lect, selectedBlock)._type),
      fieldGroups: groupFields(fields),
      hasFields: fields.length > 0,
      // A declared section the page has no block for has nothing to edit.
      missingBlock: !!entry && selectedBlock === null,
      canEdit: state.canEdit,
      editorHref: editorHref(selectedBlock, entry ? entry.key : '')
    };
  }

  /** The named section, or the one the template binds to this block. */
  function sectionEntry(section, block) {
    var found = null;
    state.sections.forEach(function (entry) {
      if (found) return;
      if (section ? entry.key === section : block !== null && entry.blockIndex === block) {
        found = entry;
      }
    });
    return found;
  }

  function editorFields(lect, languages, language, blockIndex) {
    var source = blockIndex === null ? lect : blockAt(lect, blockIndex);
    if (!source) return [];

    var fields = [];
    flattenRecord(source, {
      fields: fields,
      path: blockIndex === null ? [] : ['_blocks', blockIndex],
      languages: new Set(languages.concat(['mis'])),
      language: language,
      group: blockIndex === null ? copy.pageValues : copy.blockSettings,
      skipBlocks: blockIndex === null
    });
    return fields;
  }

  function flattenRecord(record, context) {
    Object.entries(record).forEach(function (entry) {
      var key = entry[0];
      var value = entry[1];
      if (readOnlyKey(key)) return;
      if (context.skipBlocks && key === '_blocks') return;
      var path = context.path.concat([key]);

      if (isLanguageMap(value, context.languages)) {
        pushField(context.fields, {
          path: path.concat([context.language]),
          key: key,
          value: value[context.language],
          kind: 'localized',
          badge: context.language,
          group: context.group,
          readOnly: false
        });
        return;
      }

      if (Array.isArray(value)) {
        value.forEach(function (item, index) {
          if (!isRecord(item)) return;
          flattenRecord(item, {
            fields: context.fields,
            path: path.concat([index]),
            languages: context.languages,
            language: context.language,
            group: formatCopy(copy.itemGroup, { key: humanize(key), number: index + 1 }),
            skipBlocks: false
          });
        });
        return;
      }

      if (isRecord(value)) {
        flattenRecord(value, {
          fields: context.fields,
          path: path,
          languages: context.languages,
          language: context.language,
          group: key === '_pointers' ? copy.pagePointers : humanize(key),
          skipBlocks: false
        });
        return;
      }

      var parentKey = context.path.length ? context.path[context.path.length - 1] : '';
      pushField(context.fields, {
        path: path,
        key: key,
        value: value,
        kind: key.charAt(0) === '_' ? 'structure' : parentKey === '_pointers' ? 'pointer' : 'attribute',
        badge: key.charAt(0) === '_' ? copy.system : parentKey === '_pointers' ? copy.pointer : copy.attribute,
        group: context.group,
        readOnly: false
      });
    });
  }

  function pushField(fields, input) {
    var path = '/' + input.path.map(function (segment) {
      return encodeURIComponent(String(segment));
    }).join('/');
    var value = scalar(input.value);
    fields.push({
      inputName: 'field:' + path,
      label: humanize(input.key),
      path: path,
      value: value,
      kind: input.kind,
      badge: input.badge,
      multiline: multilineKey(input.key) || value.length > 120 || /<[^>]+>/.test(value),
      readOnly: input.readOnly,
      group: input.group
    });
  }

  function groupFields(fields) {
    var labels = [];
    fields.forEach(function (field) {
      if (labels.indexOf(field.group) === -1) labels.push(field.group);
    });
    return labels.map(function (label) {
      return {
        label: label,
        fields: fields.filter(function (field) { return field.group === label; })
      };
    });
  }

  function renderPanel(panel) {
    selectedLabel.textContent = stringValue(panel.selectedLabel);
    selectedType.textContent = stringValue(panel.selectedType);
    selectedType.hidden = !panel.selectedType;
    selectedBlockInput.value = panel.selectedBlock === null ? '' : String(panel.selectedBlock);
    selectedSectionInput.value = stringValue(panel.selectedSection);
    fieldsHost.replaceChildren();

    panel.fieldGroups.forEach(function (group) {
      var fieldset = element('fieldset', 'mb-5 min-w-0');
      var legend = element(
        'legend',
        'mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500',
        stringValue(group.label)
      );
      var list = element('div', 'space-y-3');
      group.fields.forEach(function (field) {
        list.appendChild(renderField(field, panel.canEdit));
      });
      fieldset.appendChild(legend);
      fieldset.appendChild(list);
      fieldsHost.appendChild(fieldset);
    });

    if (!panel.hasFields) {
      fieldsHost.appendChild(element(
        'p',
        'rounded-lg bg-gray-50 px-3 py-4 text-sm text-gray-500',
        copy.noScalarValues
      ));
    }

    // These inputs are new nodes, so anything another editor is in has to be
    // outlined again — the highlight belongs to the field, not to the element
    // that happened to be showing it.
    repaintFields();
  }

  function renderField(field, canEdit) {
    var label = element('label', 'block min-w-0');
    var heading = element(
      'span',
      'mb-1 flex items-center justify-between gap-2 text-sm font-medium text-gray-700'
    );
    heading.appendChild(element('span', 'truncate', stringValue(field.label)));
    heading.appendChild(element(
      'span',
      'shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-500',
      stringValue(field.badge)
    ));
    label.appendChild(heading);

    var control;
    if (field.multiline) {
      control = element(
        'textarea',
        'block min-w-0 w-full max-w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500'
      );
      control.rows = 4;
      control.value = stringValue(field.value);
    } else {
      control = element(
        'input',
        'block h-10 min-w-0 w-full max-w-full rounded-lg border border-gray-300 px-3 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500'
      );
      control.value = stringValue(field.value);
    }
    control.name = stringValue(field.inputName);
    control.readOnly = field.readOnly === true || !canEdit;
    label.appendChild(control);
    label.appendChild(element(
      'span',
      'mt-1 block truncate font-mono text-xs text-gray-400',
      stringValue(field.path)
    ));
    return label;
  }

  /**
   * The mode bar belongs to a block, and focusing one here never reloads the
   * page, so it has to be revealed and re-pointed at the block now selected.
   */
  function syncSettingsModes(block, section) {
    var modes = root.querySelector('[data-theme-editor-modes]');
    if (!modes) return;
    modes.hidden = block === null && !section;
    if (modes.hidden) return;

    var href = editorHref(block, section);
    modes.querySelectorAll('[data-theme-editor-mode]').forEach(function (link) {
      link.href = link.getAttribute('data-theme-editor-mode') === 'schema'
        ? href + (href.indexOf('?') === -1 ? '?' : '&') + 'settings=schema'
        : href;
    });
  }

  function updateNavigation(block, section) {
    root.querySelectorAll('[data-theme-editor-focus]').forEach(function (link) {
      var active = blockFromValue(link.getAttribute('data-block')) === block
        && (link.getAttribute('data-section') || '') === (section || '');
      link.classList.toggle('bg-indigo-50', active);
      link.classList.toggle('font-semibold', active);
      link.classList.toggle('text-indigo-700', active);
      link.classList.toggle('text-gray-700', !active);
      link.classList.toggle('hover:bg-gray-50', !active);
      if (active) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
  }

  function selectBlockInPreview(block, scrollToBlock) {
    if (!preview) return;
    try {
      var selected = null;
      preview.contentDocument.querySelectorAll('[data-theme-editor-block]').forEach(function (wrapper) {
        var active = block !== null && Number(wrapper.getAttribute('data-theme-editor-block')) === block;
        wrapper.classList.toggle('is-selected', active);
        if (active) selected = wrapper;
      });
      if (scrollToBlock && selected) {
        selected.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } catch (_error) {
      // Same-origin access is an enhancement; links remain functional.
    }
  }

  function editorHref(block, section) {
    var url = new URL(editorAction, window.location.origin);
    if (state.themeId) url.searchParams.set('theme', state.themeId);
    if (state.templateId) url.searchParams.set('template', state.templateId);
    url.searchParams.set('page_id', String(state.pageId));
    url.searchParams.set('language', state.language);
    if (section) url.searchParams.set('section', section);
    else url.searchParams.delete('section');
    if (block !== null) url.searchParams.set('block', String(block));
    else url.searchParams.delete('block');
    return url.pathname + url.search;
  }

  function blockAt(lect, index) {
    return Array.isArray(lect._blocks) && isRecord(lect._blocks[index])
      ? lect._blocks[index]
      : null;
  }

  function validBlockIndex(lect, index) {
    return index !== null && blockAt(lect, index) !== null;
  }

  function isLanguageMap(value, languages) {
    if (!isRecord(value)) return false;
    var entries = Object.entries(value);
    return entries.length > 0 && entries.every(function (entry) {
      var key = entry[0];
      var candidate = entry[1];
      return (languages.has(key) || /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(key))
        && (candidate === null || ['string', 'number', 'boolean'].indexOf(typeof candidate) !== -1);
    });
  }

  function readOnlyKey(key) {
    return key === '_id' || key === '_type' || key === '_weight';
  }

  function multilineKey(key) {
    return /(body|description|summary|content|html|markdown|note|address|hours|bio|quote|answer)$/i.test(key);
  }

  function humanize(value) {
    var label = value
      .replace(/^_+/, '')
      .replace(/[-_]+/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .trim();
    return label ? label.charAt(0).toUpperCase() + label.slice(1) : copy.valueFallback;
  }

  function scalar(value) {
    return value === null || value === undefined
      ? ''
      : ['string', 'number', 'boolean'].indexOf(typeof value) !== -1 ? String(value) : '';
  }

  function positiveInteger(value) {
    return Number.isInteger(Number(value)) && Number(value) > 0;
  }

  function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function blockFromValue(value) {
    if (value === null || value === '') return null;
    var parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  function stringValue(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function element(tagName, className, text) {
    var node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ── Presence ──────────────────────────────────────────────────────────────
  //
  // Who else has this page open, and which field they are in. Both come from
  // the CMS's own editing session for the page — the same endpoints its native
  // editor uses — so the two editors see each other rather than each keeping a
  // private idea of who is here.
  //
  // Deliberately receive-mostly on the sync socket: this sends `focus`/`blur`,
  // which the host relays and never stores, but never `op`. An op joins the
  // shared overlay of uncommitted edits, and that overlay is committed by the
  // CMS's own save route — which this editor does not use, it writes through
  // the plugin API — so an op sent from here would leave every other editor
  // showing a pending change that nothing ever clears.
  //
  // Every part of this is an enhancement: a reader without the CMS permission
  // for the editing session gets 403s here and an editor that works exactly as
  // it did before.
  function setupPresence() {
    var host = root.querySelector('[data-theme-editor-presence]');
    if (!host) return;
    var pageId = host.getAttribute('data-presence-page-id') || '';
    var selfId = host.getAttribute('data-presence-user-id') || '';
    if (!pageId || !selfId) return;

    var presenceUrl = '/admin/api/presence/' + encodeURIComponent(pageId);
    var lastActive = new Date().toISOString();
    ['mousemove', 'keydown', 'click', 'scroll'].forEach(function (name) {
      document.addEventListener(name, function () {
        lastActive = new Date().toISOString();
      }, { passive: true });
    });

    function heartbeat() {
      window.fetch(presenceUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ lastActive: lastActive }),
      }).catch(function () {});
    }

    function refresh() {
      window.fetch(presenceUrl, { credentials: 'same-origin' })
        .then(function (response) { return response.ok ? response.json() : []; })
        .then(function (editors) { renderPresence(host, selfId, editors); })
        .catch(function () {});
    }

    heartbeat();
    refresh();
    window.setInterval(heartbeat, 30000);
    window.setInterval(refresh, 8000);
    window.addEventListener('beforeunload', function () {
      window.fetch(presenceUrl, { method: 'DELETE', keepalive: true, credentials: 'same-origin' })
        .catch(function () {});
    });

    connectFieldPresence(pageId);
  }

  function renderPresence(host, selfId, editors) {
    var list = Array.isArray(editors) ? editors : [];
    var now = Date.now();
    var IDLE_MS = 5 * 60 * 1000;
    host.replaceChildren();

    list.forEach(function (entry) {
      var userId = stringValue(entry && entry.user_id);
      var userName = stringValue(entry && entry.user_name);
      var idle = now - new Date(stringValue(entry && entry.last_active)).getTime() > IDLE_MS;
      var node = element(
        'div',
        'inline-flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold text-white'
      );
      node.textContent = initialsOf(userName);
      node.style.background = presenceColor(userId);
      node.style.opacity = idle ? '0.4' : '1';
      node.title = userName + (idle ? copy.idle : '') + (userId === selfId ? copy.you : '');
      host.appendChild(node);
    });
  }

  /**
   * Listens for who is in which field. `focus`/`blur` are a pure relay the
   * host never stores, so this costs nothing when nobody else is here.
   */
  function connectFieldPresence(pageId) {
    var socket;
    try {
      socket = new WebSocket(
        (window.location.protocol === 'https:' ? 'wss://' : 'ws://')
        + window.location.host + '/admin/api/sync/' + encodeURIComponent(pageId)
      );
    } catch (_error) {
      return;
    }

    socket.onmessage = function (event) {
      var message;
      try {
        message = JSON.parse(event.data);
      } catch (_error) {
        return;
      }
      if (!isRecord(message) || typeof message.path !== 'string') return;
      // `op` counts as editing too: someone typing has the field, whether or
      // not a focus arrived first.
      if (message.type === 'focus' || message.type === 'op') {
        markFieldEditor(message.path, stringValue(message.userId), stringValue(message.userName));
      } else if (message.type === 'blur') {
        clearFieldEditor(message.path, stringValue(message.userId));
      }
    };
    socket.onerror = function () {};

    // The host names a field by its input's `name`, which is also how this
    // editor names its own — so the two agree without a translation layer.
    var send = function (type, name) {
      if (!name || !socket || socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(JSON.stringify({ type: type, path: name }));
      } catch (_error) {
        // A closed socket is not worth reporting: presence is an enhancement.
      }
    };
    root.addEventListener('focusin', function (event) {
      if (isEditableField(event.target)) send('focus', event.target.name);
    });
    root.addEventListener('focusout', function (event) {
      if (isEditableField(event.target)) send('blur', event.target.name);
    });
  }

  function isEditableField(node) {
    return !!node && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT')
      && typeof node.name === 'string' && node.name !== '';
  }

  var fieldEditors = {};

  function markFieldEditor(path, userId, userName) {
    if (!fieldEditors[path]) fieldEditors[path] = {};
    fieldEditors[path][userId] = userName;
    paintField(path);
  }

  function clearFieldEditor(path, userId) {
    if (!fieldEditors[path]) return;
    delete fieldEditors[path][userId];
    if (Object.keys(fieldEditors[path]).length === 0) delete fieldEditors[path];
    paintField(path);
  }

  /**
   * Outlines the field someone else is in. The panel is redrawn as selections
   * change, so this is applied by lookup each time rather than held on a node
   * that may no longer be on the page.
   */
  function paintField(path) {
    var field = root.querySelector('[name="' + cssEscape(path) + '"]');
    if (!field) return;
    var editors = fieldEditors[path] ? Object.keys(fieldEditors[path]) : [];
    if (editors.length === 0) {
      field.style.outline = '';
      field.style.outlineOffset = '';
      field.removeAttribute('title');
      return;
    }
    var names = editors.map(function (userId) { return fieldEditors[path][userId]; })
      .filter(Boolean);
    field.style.outline = '2px solid ' + presenceColor(editors[0]);
    field.style.outlineOffset = '1px';
    field.title = formatCopy(copy.editingThis, {
      names: names.join(', ') || copy.someoneElse
    });
  }

  /** Repaints after a redraw, so an outline survives changing selection. */
  function repaintFields() {
    Object.keys(fieldEditors).forEach(paintField);
  }

  function cssEscape(value) {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function presenceColor(userId) {
    var palette = ['#6366f1', '#ec4899', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#f97316'];
    var hash = 0;
    for (var index = 0; index < userId.length; index += 1) {
      hash = (hash * 31 + userId.charCodeAt(index)) & 0xffffff;
    }
    return palette[Math.abs(hash) % palette.length];
  }

  function initialsOf(name) {
    return name.trim().split(/\s+/).map(function (word) {
      return word[0] || '';
    }).join('').slice(0, 2).toUpperCase() || '?';
  }

  setupPresence();
})();
