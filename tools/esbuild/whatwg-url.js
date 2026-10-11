// Stands in for whatwg-url in the bundle. node-fetch 2 only falls back to it
// when node's own url.URL is missing, which never happens in VS Code, and the
// real one drags in ~280 KB of unicode tables (tr46).
module.exports = { URL: require('url').URL };
