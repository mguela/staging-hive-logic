// Generate the VAPID keypair that desktop notifications are signed with.
//
// Run this ONCE, then paste both values into Vercel as environment variables.
// The private key is a credential: anyone holding it can push a notification to
// every browser that ever subscribed, so it goes in Vercel and nowhere else --
// not in the repo, not in a chat window, not in a screenshot.
//
//   node scripts/gen-vapid-keys.mjs
//
// Changing these later invalidates every existing subscription: each browser
// has to be turned on again. Generate them once and leave them alone.

import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();

console.log('');
console.log('Add these three to Vercel → Settings → Environment Variables');
console.log('(Production, Preview and Development), then redeploy:');
console.log('');
console.log('  REINA_VAPID_PUBLIC_KEY   =', keys.publicKey);
console.log('  REINA_VAPID_PRIVATE_KEY  =', keys.privateKey);
console.log('  REINA_VAPID_SUBJECT      = mailto:chris@ghgrp.net');
console.log('');
console.log('The PRIVATE key is a credential. Paste it straight into Vercel and');
console.log('do not save it anywhere else.');
console.log('');
