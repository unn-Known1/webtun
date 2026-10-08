// Static and dynamically rendered controls name an action; feature files own
// its implementation. No handler source text is evaluated at runtime.
const uiActions = (() => {
  const handlers = new Map();
  const attributes = { click: 'data-action', change: 'data-change-action', input: 'data-input-action', keydown: 'data-keydown-action' };
  function register(event, actions) {
    if (!attributes[event]) throw new Error('Unsupported action event: ' + event);
    for (const [name,handler] of Object.entries(actions)) {
      const key = event + ':' + name;
      if (handlers.has(key)) throw new Error('Duplicate UI action: ' + key);
      handlers.set(key,handler);
    }
  }
  function dispatch(event) {
    const attribute = attributes[event.type];
    for (let element = event.target instanceof Element ? event.target : event.target?.parentElement; element; element = element.parentElement) {
      const name = element.getAttribute(attribute);
      if (name && !element.disabled && !element.closest('[inert]')) {
        const handler = handlers.get(event.type + ':' + name);
        if (!handler) { console.warn('Unknown UI action:',name); continue; }
        try {
          const result = handler.call(element,event);
          if (result === false) event.preventDefault();
          if (result && typeof result.catch === 'function') result.catch(reportError);
        } catch (error) { reportError(error); }
      }
      if (event.cancelBubble) break;
    }
  }
  function reportError(error) {
    console.error('UI action failed:',error);
    if (typeof toast === 'function') toast('Action failed — please try again','error');
  }
  for (const event of Object.keys(attributes)) document.addEventListener(event,dispatch);
  return { register, has: (event,name) => handlers.has(event+':'+name) };
})();
