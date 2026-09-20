# README screenshots

These images capture the built extension's side-panel and artifact pages at 460 × 620 pixels in an isolated Chromium profile. The conversation and venue details are fictional, seeded for documentation; no model run or real booking is depicted.

To recreate them, build the extension, load `dist/` in a disposable profile, open its `sidepanel.html` page, and run `scripts/seed-readme-demo.js` in that page's console. The script replaces that installation's settings and chat list. Reload the page, capture the conversation, then open the `venues.md` link, choose **Open artifact in new tab**, set that tab to the same viewport size, and capture the file viewer. Do not run the fixture in your everyday browser profile.

Only the extension viewport is captured. No browser chrome, account credentials, personal tabs, or machine paths are included. The sample model endpoint is an unused loopback address; the fixture makes no model requests.
