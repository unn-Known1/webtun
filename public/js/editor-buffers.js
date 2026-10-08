// Document state is independent of CodeMirror, the textarea, and the surface
// displaying it. A handover moves this object rather than copying its fields.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WebTunEditorBuffers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createStore({ storage, delay = 2000, schedule = setTimeout, cancel = clearTimeout }) {
    const buffers = new Map();
    const key = path => 'wt-draft:' + path;
    function readDraft(path) { try { return storage.getItem(key(path)); } catch { return null; } }
    function removeDraft(path) { try { storage.removeItem(key(path)); } catch {} }

    function createBuffer(path, seed, owner) {
      if (buffers.has(path)) throw new Error('This file already has an editor');
      let draftTimer = null;
      let saveQueue = Promise.resolve();
      const listeners = new Set();
      const buffer = {
        path, owner, content: seed.content || '',
        original: seed.original != null ? seed.original : (seed.content || ''),
        mtime: seed.mtime != null ? String(seed.mtime) : null,
        size: typeof seed.size === 'number' ? seed.size : null,
        extChanged: !!seed.extChanged, missing: !!seed.missing,
        revision: 0, saving: 0, released: false,
        get dirty() { return this.content !== this.original; },
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        notify() { for (const fn of listeners) fn(this); },
        setContent(content) {
          if (this.content === content) return;
          this.content = content;
          this.revision++;
          this.notify();
        },
        cancelDraft() { cancel(draftTimer); draftTimer = null; },
        flushDraft() {
          this.cancelDraft();
          if (this.released) return;
          try {
            if (this.dirty) storage.setItem(key(this.path), this.content);
            else removeDraft(this.path);
          } catch {}
        },
        scheduleDraft() {
          this.cancelDraft();
          if (!this.released) draftTimer = schedule(() => this.flushDraft(), delay);
        },
        save(write) {
          const snapshot = { path: this.path, content: this.content };
          this.saving++;
          this.notify();
          const operation = saveQueue.then(async () => {
            const result = await write(snapshot);
            if (result && result.success && this.path === snapshot.path) {
              this.original = snapshot.content;
              // Typing during a save remains dirty and gets its own draft.
              if (!this.released) this.flushDraft();
              else if (!buffers.has(snapshot.path) && readDraft(snapshot.path) === snapshot.content) removeDraft(snapshot.path);
            }
            return result;
          }).finally(() => { this.saving--; this.notify(); });
          saveQueue = operation.catch(() => {});
          return operation;
        },
        acceptDisk(data, expectedRevision = this.revision) {
          if (this.released || this.saving || this.revision !== expectedRevision) return false;
          this.content = this.original = data.content;
          this.revision++;
          if (data.mtime != null) this.mtime = String(data.mtime);
          if (typeof data.size === 'number') this.size = data.size;
          this.extChanged = this.missing = false;
          this.flushDraft();
          this.notify();
          return true;
        },
        release({ discard = false } = {}) {
          if (discard) { this.cancelDraft(); removeDraft(this.path); }
          else this.flushDraft();
          this.released = true;
          this.owner = null;
          listeners.clear();
          if (buffers.get(this.path) === this) buffers.delete(this.path);
        },
      };
      buffers.set(path, buffer);
      return buffer;
    }

    function createSurface(owner) {
      let buffer = null;
      let unsubscribe = null;
      let viewer = {};
      const surface = {
        onChange: null,
        get buffer() { return buffer; },
        get path() { return buffer ? buffer.path : (viewer.path || ''); },
        set path(path) {
          if (path === this.path) return;
          this.clear();
          viewer.path = path;
        },
        get original() { return buffer ? buffer.original : (viewer.original || ''); },
        set original(value) { if (buffer) buffer.original = value; else viewer.original = value; },
        get diskMtime() { return buffer ? buffer.mtime : (viewer.mtime ?? null); },
        set diskMtime(value) { if (buffer) buffer.mtime = value; else viewer.mtime = value; },
        get diskSize() { return buffer ? buffer.size : (viewer.size ?? null); },
        set diskSize(value) { if (buffer) buffer.size = value; else viewer.size = value; },
        get extChanged() { return buffer ? buffer.extChanged : !!viewer.extChanged; },
        set extChanged(value) { if (buffer) buffer.extChanged = value; else viewer.extChanged = value; },
        get missing() { return buffer ? buffer.missing : !!viewer.missing; },
        set missing(value) { if (buffer) buffer.missing = value; else viewer.missing = value; },
        open(path, seed = {}, incoming) {
          this.clear();
          if (incoming) {
            if (incoming.released || incoming.path !== path || incoming.owner) throw new Error('Invalid editor handover');
            buffer = incoming;
            buffer.owner = owner;
          } else buffer = createBuffer(path, seed, owner);
          unsubscribe = buffer.subscribe(() => { if (this.onChange) this.onChange(buffer); });
          return buffer;
        },
        take() {
          if (!buffer) return null;
          buffer.flushDraft();
          if (unsubscribe) unsubscribe();
          const outgoing = buffer;
          outgoing.owner = null;
          buffer = null;
          unsubscribe = null;
          viewer = {};
          return outgoing;
        },
        clear(options) {
          if (unsubscribe) unsubscribe();
          if (buffer) buffer.release(options);
          buffer = unsubscribe = null;
          viewer = {};
        },
      };
      return surface;
    }

    function renamePath(oldPath, newPath) {
      const buffer = buffers.get(oldPath);
      if (!buffer || oldPath === newPath) return;
      if (buffer.saving) throw new Error('Wait for this file to finish saving');
      if (buffers.has(newPath)) throw new Error('The destination already has an editor');
      buffer.cancelDraft();
      removeDraft(oldPath);
      buffers.delete(oldPath);
      buffer.path = newPath;
      buffers.set(newPath, buffer);
      buffer.flushDraft();
      buffer.notify();
    }

    return { createSurface, readDraft, removeDraft, renamePath, find: path => buffers.get(path) || null };
  }
  return { createStore };
});
