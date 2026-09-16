# Working on RAR Nav

- **Commit and push straight to `main`.** No feature branch, no pull request
  unless one is asked for by name. This is a one-person boat app: a branch
  sitting between a fix and the phone is a branch nobody merges before the gun.
- **Run the tests** with `node --test tests/*.test.js`. The `npm test` script
  (`node --test tests/`) does not resolve the directory on Node 22 and fails
  before running anything.
- **Bump `CACHE` in `sw.js`** whenever a file it caches changes, or phones that
  have the app on the home screen keep serving the old copy offline.
- **Check changes in the app, not only in the tests.** `?sim=<name>` plays a
  recorded track through the whole instrument head without a GPS or a boat —
  `data/tracks/index.json` lists them, and `SIMULATION.md` says what each is for.
