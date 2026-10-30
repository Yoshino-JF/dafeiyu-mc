// Her own !setMode choices outlive a restart. The profile's modes are the owner's defaults; what she switched herself is her decision
// and was lost on every restart (3-day run 10-26: she had turned self_preservation on after dying, and the next restart put it back
// to off). Stored per bot in bots/<name>/modes.json as { mode: on, ... } and applied after the profile defaults.
import fs from 'fs';
import path from 'path';

const file = (name) => path.join('./bots', name, 'modes.json');

export function loadModeChoices(name) {
    try { return JSON.parse(fs.readFileSync(file(name), 'utf8')) || {}; } catch { return {}; }
}

export function saveModeChoice(name, mode, on) {
    try {
        const choices = { ...loadModeChoices(name), [mode]: !!on };
        fs.mkdirSync(path.dirname(file(name)), { recursive: true });
        fs.writeFileSync(file(name), JSON.stringify(choices, null, 2));
    } catch { /* a lost preference must never break the command */ }
}
