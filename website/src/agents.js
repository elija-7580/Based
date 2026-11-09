class Component extends DCLogic {
  constructor(props) {
    super(props);
    this.state = { tick: 0, mode: 2, logN: 0, scr: 0 };
    this.events = [
      ['Main', 'split “Acme proposal” into 4 tasks'],
      ['Researcher', 'found 3 sources, added to Statistics/Reading'],
      ['Writer', 'drafted summary of Lecture 5, marked'],
      ['Main', 'asked you to approve 2 edits'],
      ['Reviewer', 'checked 14 citations, 1 fixed'],
      ['Night shift', 'filed 7 voice notes into Inbox'],
      ['Coder', 'updated the formula in Budget 2026'],
      ['Main', 'wrote the project update, 3 changes since you looked'],
      ['Researcher', 'compared 4 vendors, table ready'],
      ['Writer', 'turned the meeting into action items, 5 owners']
    ];
    this.logLines = [
      ['22:00 schedule  Night shift started, budget 0.40 €', 'var(--muted)'],
      ['22:01 plan      picked 3 tasks marked Ready', 'var(--ink-2)'],
      ['22:03 run       BSD-155 database views, branch nightly/11-10', 'var(--ink-2)'],
      ['22:41 test      412 passed, 0 failed', 'var(--synced)'],
      ['22:42 run       inbox, 7 voice notes → filed', 'var(--ink-2)'],
      ['23:05 brief     tomorrow: 2 deadlines, 1 approval', 'var(--ink-2)'],
      ['23:06 ask       “Merge BSD-155?” → waiting for you', 'var(--marker-strong)'],
      ['23:06 done      cost 0.31 €, log written', 'var(--muted)']
    ];
  }
  componentDidMount() {
    this.scrT = setInterval(() => { if (this.state.scr >= 30) { clearInterval(this.scrT); return; } this.setState({ scr: this.state.scr + 1 }); }, 45);
    this.timer = setInterval(() => {
      const t = this.state.tick + 1;
      this.setState({ tick: t, logN: (this.state.logN >= this.logLines.length + 4) ? 1 : this.state.logN + (t % 2 === 0 ? 1 : 0) });
    }, 1600);
  }
  componentWillUnmount() { clearInterval(this.timer); clearInterval(this.scrT); }
  scramble(text, p) {
    const glyphs = '#%&*+=<>/\\|01ABCDEFGHJKLMNPQRSTUVWXYZ';
    const reveal = Math.floor(text.length * p);
    let out = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (i < reveal || ch === ' ') out += ch; else out += glyphs[(i * 7 + this.state.scr * 13) % glyphs.length];
    }
    return out;
  }
  renderVals() {
    const theme = this.props.theme ?? 'light';
    const dark = theme === 'dark';
    const t = this.state.tick;
    const pct = (base, speed) => Math.min(100, (base + t * speed) % 112);
    const runsRaw = [
      ['Acme proposal', 18, 7, 'var(--marker-strong)', 'Main + 2 agents, Deep'],
      ['Thesis ch. 2 sources', 52, 5, 'var(--marker-strong)', 'Researcher, Claude'],
      ['Investor update numbers', 30, 11, 'var(--marker-strong)', 'Coder, local model'],
      ['Budget 2026 review', 70, 3, 'var(--status-ready)', 'Waiting for your approval']
    ];
    const feed = [];
    for (let i = 0; i < 6; i++) {
      const idx = (t - i + this.events.length * 100) % this.events.length;
      const mins = 41 - i * 2;
      feed.push({ time: '22:' + String(Math.max(0, mins)).padStart(2, '0'), who: this.events[idx][0], what: this.events[idx][1] });
    }
    const modes = [
      { label: 'Off', kicker: 'Agents off', title: 'A quiet, very fast notes app.', text: 'No AI buttons, no suggestions, nothing sent anywhere. Based is a complete workspace without a single model connected.', ask: false },
      { label: 'Ask every time', kicker: 'Read-only until you say yes', title: 'Agents propose. You dispose.', text: 'Agents can read what you share with them and suggest. Every change waits for your approval, with a diff.', ask: true },
      { label: 'Ask before edits', kicker: 'Default', title: 'Work freely, check in before changing your pages.', text: 'Agents research, draft and organise in their own space. Before they touch your pages, they ask, once per change set.', ask: true },
      { label: 'Work freely', kicker: 'For trusted runs', title: 'Let them run. Read the log later.', text: 'Agents edit within the budget and scope you set. Every edit is marked and can be undone in one step.', ask: false }
    ];
    const m = modes[this.state.mode];
    const cards = [
      ['Board meeting prep', 'Main, Deep'], ['Call summary Acme', 'Writer, Fast'], ['Sources ch. 2', 'Researcher, Claude'],
      ['Budget formulas', 'Coder, GPT'], ['Citations check', 'Reviewer, Auto'], ['Voice notes', 'Night shift'], ['Internship table', 'Researcher, Deep']
    ];
    const cols = ['Queued', 'Running', 'Needs you', 'Done'];
    const board = cols.map((c) => ({ t: c, cards: [] }));
    cards.forEach((c, i) => {
      const pos = Math.floor((t / 2 + i * 1.3)) % 4;
      board[pos].cards.push({ t: c[0], m: c[1], bar: pos === 1 || pos === 2 ? 1 : 0 });
    });
    board.forEach((b) => { b.n = String(b.cards.length); });
    const computes = ['Auto', 'Fast', 'Deep', 'Claude Opus', 'GPT'];
    const now = new Date();
    const p1 = Math.min(1, this.state.scr / 18);
    const p2 = Math.min(1, Math.max(0, (this.state.scr - 8) / 22));
    const ntPool = [
      { title: 'Morning briefing', t: '2 deadlines today, 1 approval waiting, 3 pages changed overnight.', time: '07:30' },
      { title: 'Done', t: 'Competitor table added to Projects/Launch. 14 sources linked.', time: '11:02' },
      { title: 'Needs you', t: 'Approve the Acme proposal draft? Two paragraphs changed.', time: '16:58' },
      { title: 'Night shift', t: 'Filed 7 voice notes and updated 3 client pages.', time: '23:10' }
    ];
    const spots = [['4%', '8%'], ['54%', '14%'], ['6%', '66%'], ['52%', '72%']];
    const notifs = [];
    for (let k = 0; k < 4; k++) { const nn = ntPool[(t + k) % ntPool.length]; notifs.push(Object.assign({}, nn, { x: spots[k][0], y: spots[k][1], d: (k * 120) + 'ms' })); }
    return {
      theme,
      scr1: this.scramble('Mission control for', p1),
      scr2: this.scramble('everything you work on.', p2),
      notifs,
      markSrcDark: '/_blob/60426240b69c9dab9372c2741257d898',
      briefs: [
        { d: 'Tue, Nov 10', s: 'Acme proposal due Friday. Thesis sources complete. Budget review moved.', dl: '2', n: '1 approval', bg: 'var(--marker)', l: 'Acme, Thesis, Budget' },
        { d: 'Mon, Nov 9', s: 'Investor update drafted. Northwind kickoff notes filed.', dl: '1', n: 'none', bg: 'var(--status-ready)', l: 'Investors, Northwind' },
        { d: 'Fri, Nov 6', s: 'Offsite booked. 3 new leads from the website form.', dl: '0', n: '2 decisions', bg: 'var(--marker)', l: 'Offsite, Leads' },
        { d: 'Thu, Nov 5', s: 'Lecture 4 summarised. Hiring post waiting for budget.', dl: '3', n: 'none', bg: 'var(--status-ready)', l: 'University, Hiring' },
        { d: 'Wed, Nov 4', s: 'Lumen API webhook live. Runs now logged.', dl: '1', n: '1 approval', bg: 'var(--marker)', l: 'Lumen Labs, Logs' }
      ],
      places: [
        { cmd: '$ based ask "update the Acme deal"', t: 'Terminal', d: 'Talk to your workspace from the CLI. Works offline against your local copy.' },
        { cmd: '→ continues in sandbox', t: 'Cloud sandbox', d: 'Close the lid. Long tasks keep running in an isolated sandbox, opt-in.' },
        { cmd: '“Yes, send it Friday”', t: 'Phone', d: 'Get the ping, answer in one line. Same session, nothing to re-explain.' },
        { cmd: 'mcp://based', t: 'Any AI via MCP', d: 'Claude, ChatGPT, Cursor and others read and write your workspace, with your rules.' }
      ],
      markSrc: dark ? '/_blob/60426240b69c9dab9372c2741257d898' : '/_blob/c3ccc021887376abcf7fe08d0002d913',
      side: [
        { t: 'Mission control', c: '', bg: 'var(--bg)', w: 600, sh: 'var(--shadow-panel)' },
        { t: 'Inbox', c: String(3 + (t % 3)), bg: 'transparent', w: 400, sh: 'none' },
        { t: 'Agents', c: '4', bg: 'transparent', w: 400, sh: 'none' },
        { t: 'Projects', c: '6', bg: 'transparent', w: 400, sh: 'none' },
        { t: 'Schedules', c: '2', bg: 'transparent', w: 400, sh: 'none' },
        { t: 'Graph', c: '', bg: 'transparent', w: 400, sh: 'none' }
      ],
      clock: String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'),
      mainMsg: t % 6 < 3 ? 'The Acme proposal is drafted and your investor update has fresh numbers. One thing needs you: approve two edits in the proposal.' : 'Sources for thesis chapter 2 are in. The writer is drafting 2.3 now, about twelve minutes left. Nothing needs you.',
      runs: runsRaw.map((r) => { const p = pct(r[1], r[2]); return { t: r[0], pct: p + '%', pctTxt: p >= 100 ? 'done' : p + ' %', c: r[3], sub: r[4] }; }),
      feed,
      computeNow: computes[t % computes.length],
      modes: modes.map((x, i) => ({ label: x.label, checked: this.state.mode === i ? 'true' : 'false', bg: this.state.mode === i ? 'var(--bg)' : 'transparent', sh: this.state.mode === i ? 'var(--shadow-control, 0 1px 2px rgba(0,0,0,.08))' : 'none', pick: () => this.setState({ mode: i }) })),
      modeKicker: m.kicker, modeTitle: m.title, modeText: m.text, modeAsk: m.ask,
      board,
      log: this.logLines.slice(0, Math.min(this.logLines.length, this.state.logN)).map((l) => ({ t: l[0], c: l[1] })),
      engines: ['ChatGPT', 'Claude', 'Claude Code', 'Codex', 'Gemini CLI', 'OpenCode', 'OpenAI API', 'Anthropic API', 'MCP for Cursor', 'MCP for Claude', 'MCP for ChatGPT', 'Your own server',
                'ChatGPT', 'Claude', 'Claude Code', 'Codex', 'Gemini CLI', 'OpenCode', 'OpenAI API', 'Anthropic API', 'MCP for Cursor', 'MCP for Claude', 'MCP for ChatGPT', 'Your own server'],
      brain: [
        { t: 'Skills', d: 'Teach an agent a routine once, like how you write client updates, and every agent can use it.' },
        { t: 'Memories', d: 'What agents learn about your projects, kept as pages you can read, edit and delete.' },
        { t: 'Daily brief', d: 'Deadlines, approvals and what changed overnight, saved as a row in your briefings database.' },
        { t: 'Answers with sources', d: 'Ask your whole workspace. Every answer links to the pages it came from.' },
        { t: 'Privacy check', d: 'Opt-in and planned: before a prompt leaves your device, a local check flags names, numbers and other private details.' },
        { t: 'Local models', d: 'Run a model on your own machine for anything sensitive. Nothing leaves the device.' }
      ]
    };
  }
}
