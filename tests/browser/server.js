'use strict';
const { createWorkspaceServer } = require('../helpers/workspace-server');
createWorkspaceServer({ port:3098 }).then(fixture => {
  let closing=false;
  const close=async () => { if(closing) return; closing=true; await fixture.close(); process.exit(0); };
  process.on('SIGINT',close); process.on('SIGTERM',close);
  console.log('Browser test workspace ready');
}).catch(error => { console.error(error); process.exit(1); });
