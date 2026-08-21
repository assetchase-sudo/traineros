# TrainerOS

Membership billing + scheduling for a solo personal trainer.

## Run locally
1. Install Node.js (https://nodejs.org)
2. In this folder run:  npm install
3. Start it:  npm run dev
4. Build for hosting:  npm run build   (output lands in /dist)

## Deploy
- Easiest (no account setup): drag the /dist folder onto https://app.netlify.com/drop
- Auto-updating: push this folder to GitHub, then import the repo at https://vercel.com

## Note
This version stores data in each browser (localStorage). It's for you to run and
refine. For you AND clients to share one live system with logins, the backend
(database + client accounts + Stripe billing) is the next step.
