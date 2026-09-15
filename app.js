/**
 * Entry point for cPanel's "Setup Node.js App" (Phusion Passenger).
 *
 * Passenger runs this file with the Node version chosen in cPanel and provides PORT.
 * It simply hands over to the compiled server. See docs/CPANEL.md.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const entry = path.join(__dirname, 'server', 'dist', 'index.js');

if (!fs.existsSync(entry)) {
  console.error(
    'The server has not been built yet.\n' +
      'Open a terminal in the application directory and run:\n' +
      '  npm ci\n' +
      '  npm run build\n' +
      'then restart the application in cPanel.',
  );
  process.exit(1);
}

process.env.NODE_ENV = process.env.NODE_ENV || 'production';

import(pathToFileURL(entry).href).catch((err) => {
  console.error('The Companion failed to start:', err);
  process.exit(1);
});
