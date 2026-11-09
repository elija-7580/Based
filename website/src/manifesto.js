class Component extends DCLogic {
  static words(text, start, step) { return text.split(' ').map((w, i, a) => ({ c: w + (i < a.length - 1 ? ' ' : ''), d: (start + i * step) + 'ms' })); }
  renderVals() {
    const theme = this.props.theme ?? 'light';
    const dark = theme === 'dark';
    const st = (i) => i < 2 ? 'done' : i === 2 ? 'now' : 'next';
    const phases = [
      ['Foundation', 'Monorepo, types, golden fixtures, CI'],
      ['Core', 'Sync, formulas, queries, search. Every fixture green'],
      ['Web client', 'Shell, editor, databases, import/export'],
      ['Cloud and agents', 'Encrypted Based Cloud, MCP, main agent, mission control'],
      ['Mac app', 'Tauri desktop with one-click updates'],
      ['Mobile', 'iPhone, iPad and Android on the same core'],
      ['Switch-over', 'Parity check, migration assistant'],
      ['Beyond Notion', 'Tabs, supertags, whiteboard, PDF notes, automations']
    ].map((p, i) => ({
      n: i, t: p[0], d: p[1], state: st(i),
      dotBg: st(i) === 'done' ? 'var(--ink)' : st(i) === 'now' ? 'var(--marker)' : 'var(--bg)',
      dotBorder: st(i) === 'now' ? 'var(--marker-strong)' : st(i) === 'done' ? 'var(--ink)' : 'var(--control-border)'
    }));
    return {
      theme,
      hw1: Component.words('We are rebuilding knowledge work.', 0, 110),
      hw2: Component.words('Starting with ', 560, 110),
      hw3: Component.words('what Notion got right.', 780, 120),
      markSrc: dark ? '/_blob/60426240b69c9dab9372c2741257d898' : '/_blob/c3ccc021887376abcf7fe08d0002d913',
      principles: [
        { n: '01', t: 'You own your data. Full stop.', d: 'Your workspace lives on your devices and opens instantly, even on a plane. Nothing gets deleted behind your back. Based Cloud runs in the EU and keeps your devices in sync without being able to read a word. Your data survives any company, including ours.' },
        { n: '02', t: 'Safety is not a pricing tier.', d: 'Version history, offline access and backups are basic rights for your own writing. Nobody should pay extra to undo a mistake from last month.' },
        { n: '03', t: 'Agents sign their work.', d: 'AI is welcome here, on your terms. Off by default, on a leash you choose, and every line it writes is marked with where it came from.' },
        { n: '04', t: 'Your AI, your keys.', d: 'You already pay for a model. Based connects to it instead of selling you a second one, and never hides which model did what.' },
        { n: '05', t: 'Built in Europe, in the open.', d: 'Made in Vienna. MIT licensed, clean-room from public documentation, with the roadmap, the backlog and every night shift log in public.' }
      ],
      crew: [
        { t: 'Elija', d: 'Human. Decides what Based is. Tests every screen on his Mac.', s: 'Vienna', bar: 0 },
        { t: 'Architect agent', d: 'Plans with Elija, writes specs and decisions into the backlog.', s: 'daytime', bar: 1 },
        { t: 'Night shift', d: 'Builds backlog items marked ready, runs the tests, merges only when green.', s: 'nightly', bar: 1 },
        { t: 'Golden fixtures', d: 'The referee. Behaviour must match the prototype before anything ships.', s: 'every commit', bar: 0 }
      ],
      nums: [
        { v: '221', l: 'Notion features tracked one by one against the public help pages' },
        { v: '178', l: 'already working in the Swift prototype' },
        { v: '9', l: 'golden fixture suites that keep behaviour identical through the rewrite' },
        { v: 'MIT', l: 'licence. Fork it, read it, audit it.' }
      ],
      phases
    };
  }
}
