#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { createServer } = require('./src/server');

function parseArgs(argv) {
  const opts = { port: 8787, host: '127.0.0.1', data: path.join(__dirname, 'data') };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[i + 1] ?? (() => { throw new Error(`${arg} needs a value`); })();
    if (arg === '--port' || arg === '-p') { opts.port = Number(next()); i += 1; }
    else if (arg === '--host') { opts.host = next(); i += 1; }
    else if (arg === '--data') { opts.data = path.resolve(next()); i += 1; }
    else if (arg === '--help' || arg === '-h') { opts.help = true; }
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

const HELP = `chrome-remote-control controller

  node index.js [options]

  --port, -p <n>   port to listen on (default 8787)
  --host <addr>    address to bind (default 127.0.0.1, loopback only)
  --data <dir>     state directory (default ./data)
  --help, -h       this message
`;

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  const { server, store, hub } = createServer({ dataDir: opts.data });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`port ${opts.port} is already in use — pass --port to pick another`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(opts.port, opts.host, () => {
    const base = `http://${opts.host === '0.0.0.0' ? 'localhost' : opts.host}:${opts.port}`;
    const policy = store.getPolicyDetail();
    console.log('');
    console.log('  chrome-remote-control controller');
    console.log(`  dashboard   ${base}/?token=${store.token}`);
    console.log(`  extension   ${base.replace('http', 'ws')}/ws   token ${store.token}`);
    console.log(`  state       ${opts.data}`);
    const count = policy.rules.length;
    console.log(
      `  policy      blocking ${policy.blockingEnabled ? 'on' : 'off'}, ` +
        `${count} rule${count === 1 ? '' : 's'}, version ${policy.version}`
    );
    if (opts.host !== '127.0.0.1' && opts.host !== 'localhost') {
      console.log('');
      console.log(`  ! bound to ${opts.host}: anyone who reaches this port and has the token`);
      console.log('    can read browsing history and change the blocklist.');
    }
    console.log('');
  });

  const shutdown = () => {
    console.log('\nshutting down');
    clearInterval(hub.timer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
