# Install on another machine

1. Install Pi, Node.js (22.19+), and npm; ensure `pi`, `node`, and `npm` are on `PATH`. Clone this repository and run from its root:

   ```sh
   npm --prefix pi/extensions/subagents ci --ignore-scripts --legacy-peer-deps
   npm --prefix pi/extensions/workflow ci --ignore-scripts --legacy-peer-deps
   ```

2. Link the checkout into Pi's user configuration. Back up or move any existing destinations first; do not overwrite credentials (`auth.json`) or other local files.

   ```sh
   mkdir -p ~/.pi/agent
   for name in extensions agents settings.json subagents.json; do
     ln -s "$(pwd)/pi/$name" "$HOME/.pi/agent/$name"
   done
   ```

3. Start `pi` and use `/login` to configure a provider. The shared `pi/settings.json` model names may require provider access or custom model definitions; adjust them for this machine if necessary. Changes to linked files affect the checkout. Restart Pi or use `/reload` after changes.

Missing-module errors usually mean step 1 was skipped. Model-pattern warnings are separate: check `pi --list-models`, credentials, and configured model names.
