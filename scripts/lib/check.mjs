/**
 * Tiny pass/fail harness shared by every cli-*-smoke.mjs script.
 *
 * Returns an object with `check(label, fn)` and `printSummary()` plus
 * counters and a `failures` list. Each script keeps its own harness so
 * separate-process semantics stay local — we don't want one script's
 * counters polluting another's.
 *
 * Skip semantics: `fn` may throw an error with `code === 'SKIP'` (or
 * call the returned `skip(reason)` helper) to mark a test as skipped
 * rather than passed/failed. Used by cli-discovery-smoke for OS-gated
 * tests.
 *
 * Exit code: `printSummary({ exit: true })` calls `process.exit(1)` if
 * any failures occurred. Call `printSummary({ exit: false })` if the
 * script wants to do its own cleanup before exiting.
 */

export const createCheckHarness = () => {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures = [];
  const skipNotes = [];

  const skip = (reason) => {
    const err = new Error(reason);
    err.code = 'SKIP';
    throw err;
  };

  const check = async (label, fn) => {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${label}`);
    } catch (err) {
      if (err && err.code === 'SKIP') {
        skipped++;
        skipNotes.push({ label, reason: err.message });
        console.log(`  ⊘ ${label} (skipped: ${err.message})`);
        return;
      }
      failed++;
      failures.push({ label, message: err.message });
      console.log(`  ✗ ${label}`);
      console.log(`    ${err.message.split('\n').join('\n    ')}`);
    }
  };

  const printSummary = ({ exit = true } = {}) => {
    const skipLabel = skipped > 0 ? `, ${skipped} skipped` : '';
    console.log(`\n${passed} passed, ${failed} failed${skipLabel}`);
    if (failed > 0) {
      console.log('\nFailures:');
      for (const f of failures) {
        console.log(`  - ${f.label}: ${f.message}`);
      }
      if (exit) process.exit(1);
    }
  };

  return {
    get passed() {
      return passed;
    },
    get failed() {
      return failed;
    },
    get skipped() {
      return skipped;
    },
    failures,
    skipNotes,
    check,
    skip,
    printSummary,
  };
};
