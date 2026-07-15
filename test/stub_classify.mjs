// Hermetic stand-in for VEclassify/classify_stage.py used by the Node route tests.
// Invoked as:  node stub_classify.mjs --folder <dir> --json
// Reads the staged folder, emits the same JSON contract on stdout.
// STUB_MODE=fail → exit 1 with a stderr message (to test the error path).
import fs from 'node:fs'

if (process.env.STUB_MODE === 'fail') {
  process.stderr.write('stub: simulated classifier failure (bad GEMINI key)\n')
  process.exit(1)
}

const i = process.argv.indexOf('--folder')
const folder = i >= 0 ? process.argv[i + 1] : null
if (!folder || !fs.existsSync(folder)) {
  process.stderr.write(`stub: folder missing: ${folder}\n`)
  process.exit(1)
}

const files = fs.readdirSync(folder).filter(f => f.toLowerCase().endsWith('.mp3'))
if (files.length === 0) {
  process.stderr.write('stub: no mp3 in folder\n')
  process.exit(1)
}

// Per-batch failure trigger: a staged file named like "*FAIL*.mp3" makes the
// stub exit 1 (so a single running server can exercise the error path).
if (files.some(f => f.toUpperCase().includes('FAIL'))) {
  process.stderr.write('stub: forced failure via FAIL sentinel\n')
  process.exit(1)
}

// Derive a category from the filename so confirm() lands files deterministically.
// Files with no keyword report "night" — the server must normalize that to evening.
const catOf = (f) =>
  f.includes('morning') ? 'morning' :
  f.includes('day')     ? 'day'     :
  f.includes('evening') ? 'evening' : 'night'

const tracks = files.map(f => {
  const base = f.replace(/\.mp3$/i, '')
  const dash = base.indexOf(' - ')
  return {
    filename:     f,
    title:        dash > 0 ? base.slice(dash + 3) : base,
    artist:       dash > 0 ? base.slice(0, dash)  : 'Unknown',
    time_of_day:  catOf(f),
    mood:         'chill',
    energy_score: 0.42,
    tempo_bpm:    100.0,
    librosa_ok:   true,
  }
})

process.stdout.write(JSON.stringify({ tracks }))
