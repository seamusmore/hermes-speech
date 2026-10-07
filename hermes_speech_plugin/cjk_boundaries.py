"""Reversible compatibility shim for older official sentence chunkers."""
import re
import threading
_lock = threading.RLock()
_states = {}

def acquire(module):
    namespace = module.SentenceChunker.feed.__globals__
    key = id(namespace)
    with _lock:
        state = _states.get(key)
        if state is None:
            old = namespace['SENTENCE_BOUNDARY_RE']
            if all(old.search('one'+c+'two') for c in '\u3002\uff01\uff1f'):
                return lambda: None
            replacement = re.compile(r'[\u3002\uff01\uff1f]|(?:'+old.pattern+')', old.flags)
            state = {'old': old, 'replacement': replacement, 'refs': 0, 'attributes': []}
            _states[key] = state
            namespace['SENTENCE_BOUNDARY_RE'] = replacement
        state['refs'] += 1
        previous = module.SENTENCE_BOUNDARY_RE
        if previous is state['old']:
            state['attributes'].append((module, previous))
            module.SENTENCE_BOUNDARY_RE = state['replacement']
    released = False
    def release():
        nonlocal released
        with _lock:
            if released: return
            released = True
            state['refs'] -= 1
            if state['refs']: return
            if namespace.get('SENTENCE_BOUNDARY_RE') is state['replacement']:
                namespace['SENTENCE_BOUNDARY_RE'] = state['old']
            for owner, previous in state['attributes']:
                if owner.SENTENCE_BOUNDARY_RE is state['replacement']:
                    owner.SENTENCE_BOUNDARY_RE = previous
            _states.pop(key, None)
    return release


_registry_states = {}
def register_owned(registry, name, value):
    """Restore only owned entries, including out-of-order profile unload."""
    key = (id(registry), name)
    with _lock:
        state = _registry_states.get(key)
        if state is None or registry.get(name) is not state['last']:
            state = {'base': registry.get(name), 'entries': [], 'last': None}
            _registry_states[key] = state
        entry = [value, True]
        state['entries'].append(entry)
        state['last'] = registry[name] = value
    def release():
        with _lock:
            entry[1] = False
            if registry.get(name) is not state['last']: return
            while state['entries'] and not state['entries'][-1][1]:state['entries'].pop()
            replacement = state['entries'][-1][0] if state['entries'] else state['base']
            if replacement is None: registry.pop(name, None)
            else: registry[name] = replacement
            state['last'] = replacement
            if not state['entries'] and _registry_states.get(key) is state:_registry_states.pop(key, None)
    return release

