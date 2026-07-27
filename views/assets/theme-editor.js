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
  var panelViewport = root.querySelector('[data-theme-editor-panel-viewport]');
  var panelTrack = root.querySelector('[data-theme-editor-panel-track]');
  var listPanel = root.querySelector('[data-theme-editor-list-panel]');
  var settingsPanel = root.querySelector('[data-theme-editor-settings-panel]');
  var listHeading = root.querySelector('[data-theme-editor-list-heading]');
  var saveButton = root.querySelector('[data-theme-editor-save-button]');
  var saveStatus = root.querySelector('[data-theme-editor-save-status]');
  var preview = root.querySelector('[data-theme-editor-preview]');
  if (!editorAction || !stateSource || !form || !fieldsHost || !selectedLabel || !selectedType
    || !selectedBlockInput || !panelViewport || !panelTrack || !listPanel || !settingsPanel
    || !listHeading) return;

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

  var dirty = false;
  var saving = false;
  var previewTimer = 0;
  var inspectorView = blockFromValue(selectedBlockInput.value) === null ? 'list' : 'settings';

  setInspectorView(inspectorView, false, false);
  window.addEventListener('resize', syncPanelHeight);

  form.addEventListener('input', function (event) {
    var target = event.target;
    if (target && typeof target.name === 'string' && target.name.indexOf('field:/') === 0) {
      dirty = true;
      clearSaveStatus();
      schedulePreviewRender();
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

  root.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') return;

    var close = target.closest('[data-theme-editor-close]');
    if (close && root.contains(close)) {
      event.preventDefault();
      setInspectorView('list', true, true);
      return;
    }

    var link = target.closest('[data-theme-editor-focus]');
    if (!link || !root.contains(link)) return;
    event.preventDefault();
    focusBlock(blockFromValue(link.getAttribute('data-block')), link.href, true, 'settings');
  });

  if (preview) {
    preview.addEventListener('load', bindPreview);
    bindPreview();
  }

  window.addEventListener('popstate', function () {
    var params = new URL(window.location.href).searchParams;
    var historyView = window.history.state && window.history.state.themeEditorView;
    var view = historyView === 'settings' || historyView === 'list'
      ? historyView
      : params.has('block') ? 'settings' : 'list';
    focusBlock(blockFromValue(params.get('block')), window.location.href, false, view);
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
          event.preventDefault();
          focusBlock(
            blockFromValue(wrapper.getAttribute('data-theme-editor-block')),
            link.href,
            true,
            'settings'
          );
          return;
        }

        if (target.closest('[data-theme-editor-block]')) return;
        if (isInteractiveTarget(target)) return;
        if (blockFromValue(selectedBlockInput.value) === null) return;

        focusBlock(null, editorHref(null), true, 'list');
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
  function frameRenderer() {
    if (!preview) return null;
    try {
      var api = preview.contentWindow && preview.contentWindow.themeEditorPreview;
      return api && typeof api.render === 'function' ? api : null;
    } catch (_error) {
      return null;
    }
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

  function focusBlock(block, fallbackHref, pushHistory, nextView) {
    if (saving) return;
    if (dirty && !window.confirm('Discard unsaved changes in this selection?')) return;
    dirty = false;
    clearSaveStatus();

    try {
      var panel = composePanel(block);
      renderPanel(panel);
      updateNavigation(panel.selectedBlock);
      selectBlockInPreview(panel.selectedBlock, true);
      if (fieldsScroll) fieldsScroll.scrollTop = 0;
      setInspectorView(nextView, true, true);

      if (pushHistory) {
        window.history.pushState(
          {
            themeEditorBlock: panel.selectedBlock,
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

  /** Raw page lect + selected block → the inspector view model. */
  function composePanel(block) {
    var selectedBlock = validBlockIndex(state.lect, block) ? block : null;
    var fields = editorFields(state.lect, state.languages, state.language, selectedBlock);
    return {
      selectedBlock: selectedBlock,
      selectedLabel: selectedBlock === null ? 'Page settings' : 'Block ' + (selectedBlock + 1),
      selectedType: selectedBlock === null ? '' : scalar(blockAt(state.lect, selectedBlock)._type),
      fieldGroups: groupFields(fields),
      hasFields: fields.length > 0,
      canEdit: state.canEdit,
      editorHref: editorHref(selectedBlock)
    };
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

  function updateNavigation(block) {
    root.querySelectorAll('[data-theme-editor-focus]').forEach(function (link) {
      var active = blockFromValue(link.getAttribute('data-block')) === block;
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

  function editorHref(block) {
    var url = new URL(editorAction, window.location.origin);
    if (state.themeId) url.searchParams.set('theme', state.themeId);
    if (state.templateId) url.searchParams.set('template', state.templateId);
    url.searchParams.set('page_id', String(state.pageId));
    url.searchParams.set('language', state.language);
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
