(function () {
  'use strict';

  var root = document.querySelector('[data-theme-editor]');
  if (!root) return;

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
  var settingsMode = root.getAttribute('data-settings-mode') === 'schema' ? 'schema' : 'values';
  var inspectorView = blockFromValue(selectedBlockInput.value) === null
    && !selectedSectionInput.value
    ? 'list'
    : 'settings';

  setInspectorView(inspectorView, false, false);
  window.addEventListener('resize', syncPanelHeight);

  form.addEventListener('input', function (event) {
    var target = event.target;
    if (!target || typeof target.name !== 'string') return;
    if (target.name.indexOf('field:/') === 0) {
      dirty = true;
      clearSaveStatus();
      schedulePreviewRender();
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
      // Both panels are already on the page, so the switch is local — unless
      // the schema panel describes a block other than the selected one, which
      // only the server can re-render.
      if (!schemaPanelMatchesSelection()) return;
      event.preventDefault();
      setSettingsMode(mode.getAttribute('data-theme-editor-mode'), mode.href);
      return;
    }

    var link = target.closest('[data-theme-editor-focus]');
    if (!link || !root.contains(link)) return;
    // Schema mode is rendered from the section's own {% schema %}, which this
    // page cannot compose locally, so let the link load it from the server.
    if (settingsMode === 'schema') return;
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
    loadForm.querySelectorAll('select').forEach(function (select) {
      select.setAttribute('data-loaded-value', select.value);
    });
    loadForm.addEventListener('change', function (event) {
      var select = event.target;
      if (!select || select.tagName !== 'SELECT' || !loadForm.contains(select)) return;
      if (dirty && !window.confirm('Discard unsaved changes in this selection?')) {
        // Leaving the new choice showing would describe a page that was never
        // loaded, so put the selector back to what is on screen.
        select.value = select.getAttribute('data-loaded-value') || select.value;
        return;
      }
      dirty = false;
      loadForm.submit();
    });
    var loadButton = loadForm.querySelector('[data-theme-editor-load-button]');
    if (loadButton) loadButton.hidden = true;
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
      if (previewDocument.documentElement.hasAttribute('data-theme-editor-bound')) {
        selectBlockInPreview(blockFromValue(selectedBlockInput.value));
        return;
      }
      previewDocument.documentElement.setAttribute('data-theme-editor-bound', '1');
      previewDocument.addEventListener('click', function (event) {
        var target = event.target;
        if (!target || typeof target.closest !== 'function') return;

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

  async function saveChanges() {
    if (saving || !saveButton || !saveStatus) return;
    saving = true;
    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
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
            : 'Changes could not be saved.'
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
        typeof payload.message === 'string' ? payload.message : 'Changes saved',
        false
      );
      refreshPreview();
    } catch (error) {
      showSaveStatus(
        error instanceof Error && error.message
          ? error.message
          : 'Changes could not be saved.',
        true
      );
    } finally {
      saving = false;
      saveButton.disabled = false;
      saveButton.textContent = 'Save changes';
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
        : 'Changes could not be saved.'
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
   * The schema panel is rendered by the server for one block. Composing a
   * different block here cannot rebuild it, so the mode links fall back to
   * loading that block when the two no longer agree.
   */
  function schemaPanelMatchesSelection() {
    var modes = root.querySelector('[data-theme-editor-modes]');
    if (!modes) return false;
    return modes.getAttribute('data-schema-block') === (selectedBlockInput.value || '')
      && (modes.getAttribute('data-schema-section') || '') === (selectedSectionInput.value || '');
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
      button.textContent = hidden ? 'Show' : 'Hide';
      button.title = (hidden ? 'Show' : 'Hide') + ' the ' + section
        + ' section in every page using this template';
    }
    if (flag) flag.hidden = !hidden;
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
      hint.textContent = text || 'Empty';
    }).catch(function () {
      hint.textContent = 'Could not resolve this binding.';
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
      if (result && typeof result.catch === 'function') result.catch(reloadPreview);
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
    if (dirty && !window.confirm('Discard unsaved changes in this selection?')) return;
    dirty = false;
    clearSaveStatus();

    try {
      var panel = composePanel(block, section);
      // A section the page has no block for opens on its bindings, which are
      // rendered from the theme's own {% schema %} — only the server has that.
      if (panel.missingBlock) {
        window.location.assign(fallbackHref);
        return;
      }
      renderPanel(panel);
      updateNavigation(panel.selectedBlock, panel.selectedSection);
      syncSettingsModes(panel.selectedBlock, panel.selectedSection);
      selectBlockInPreview(panel.selectedBlock, true);
      if (fieldsScroll) fieldsScroll.scrollTop = 0;
      setInspectorView(nextView, true, true);

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
        : selectedBlock === null ? 'Page settings' : 'Block ' + (selectedBlock + 1),
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
      group: blockIndex === null ? 'Page values' : 'Block settings',
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
            group: humanize(key) + ' · item ' + (index + 1),
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
          group: key === '_pointers' ? 'Page pointers' : humanize(key),
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
        badge: key.charAt(0) === '_' ? 'system' : parentKey === '_pointers' ? 'pointer' : 'attribute',
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
        'This selection has no scalar values to edit yet.'
      ));
    }
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
    return label ? label.charAt(0).toUpperCase() + label.slice(1) : 'Value';
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
})();
