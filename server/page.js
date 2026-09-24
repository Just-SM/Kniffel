'use strict';

// Builds the single inlined page (public/index.html has __SHEET_CSS__ and
// __SHEET_JS__ placeholders). Everything is inlined so there are
// no subresource URLs for adblock filter lists to block. Call before Listen.
const fs = require('fs');
const path = require('path');

function buildPage() {
  const root = path.join(__dirname, '..', 'public');
  const tpl = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

  const css = fs.readFileSync(path.join(root, 'sheet.css'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'sheet.js'), 'utf8');

  // avoid accidental </script> termination inside inlined code
  const safe = (s) => s.replace(/<\/script/gi, '<\\/script');
  return tpl
    .replace('__SHEET_CSS__', () => safe(css))
    .replace('__SHEET_JS__', () => safe(app));
}

module.exports = { buildPage };