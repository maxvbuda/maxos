// Minimal preload. Kept intentionally empty of bridges — MaxOS is a normal web
// app and needs no privileged native APIs. Exists so a contextBridge can be
// added later (e.g. native notifications) without touching the page's trust model.
