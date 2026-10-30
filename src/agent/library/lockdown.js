import 'ses';

// This sets up the secure environment
// We disable some of the taming to allow for more flexibility

// For configuration, see https://github.com/endojs/endo/blob/master/packages/ses/docs/lockdown.md

let lockeddown = false;
export function lockdown() {
  if (lockeddown) return;
  // dafeiyu 2026-10-26 (GPT #3019): this export shadows SES's global lockdown, so the upstream call below reached itself and SES
  // never ran - the intrinsics stayed mutable and Function stayed reachable from endowed host objects. Call the global one, and
  // mark done only once it has succeeded.
  globalThis.lockdown({
    // basic devex and quality of life improvements
    localeTaming: 'unsafe',
    consoleTaming: 'unsafe',
    errorTaming: 'unsafe',
    stackFiltering: 'verbose',
    // allow eval outside of created compartments
    // (mineflayer dep "protodef" uses eval)
    evalTaming: 'unsafeEval',
  });
  lockeddown = true;
  console.log('[sandbox] SES lockdown applied');
}

export const makeCompartment = (endowments = {}) => {
  lockdown();   // dafeiyu: never a compartment before the realm is hardened, whoever forgets to call lockdown first
  return new Compartment({
    // provide untamed Math, Date, etc
    Math,
    Date,
    // standard endowments
    ...endowments
  });
}