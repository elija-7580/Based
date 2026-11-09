class Component extends DCLogic {
  constructor(props) {
    super(props);
    this.state = { area: 'All', votes: {}, ideas: [], draft: '', draftArea: 'Workspace', thanks: false };
  }
  static words(text, start, step) { return text.split(' ').map((w, i, a) => ({ c: w, sp: i < a.length - 1 ? ' ' : '', d: (start + i * step) + 'ms' })); }
  static data() {
    // Generated from Notion "Based Backlog" (Roadmap, Roadmap-Titel, Website-Bereich) by sync_roadmap.py. Do not edit by hand.
    const rows = /*ROADMAP*/[{"id": 186, "Roadmap": "Shipped", "t": "Pages and the block editor", "a": "Workspace"}, {"id": 187, "Roadmap": "Shipped", "t": "Databases with six views", "a": "Databases"}, {"id": 188, "Roadmap": "Shipped", "t": "Formulas, relations, rollups", "a": "Databases"}, {"id": 189, "Roadmap": "Shipped", "t": "Meeting notes transcribed on device", "a": "Workspace"}, {"id": 190, "Roadmap": "Shipped", "t": "Import from Notion", "a": "Workspace"}, {"id": 8, "Roadmap": "Now", "t": "Calendar and timeline views, virtualised", "a": "Databases"}, {"id": 73, "Roadmap": "Now", "t": "Version history that never deletes", "a": "Workspace"}, {"id": 158, "Roadmap": "Now", "t": "Sync v2 and the MCP server", "a": "Sync"}, {"id": 164, "Roadmap": "Now", "t": "Mac app with one-click updates", "a": "Mobile and apps"}, {"id": 181, "Roadmap": "Now", "t": "Quick Find, import and export", "a": "Workspace"}, {"id": 182, "Roadmap": "Now", "t": "Tabs and the web app", "a": "Workspace"}, {"id": 191, "Roadmap": "Now", "t": "New editor on BlockNote and Yjs", "a": "Workspace"}, {"id": 160, "Roadmap": "Next", "t": "Main agent, runs and permissions", "a": "Agents"}, {"id": 163, "Roadmap": "Next", "t": "Morning briefings, memories and skills", "a": "Agents"}, {"id": 167, "Roadmap": "Next", "t": "Apple Watch and iPhone quick capture", "a": "Mobile and apps"}, {"id": 184, "Roadmap": "Next", "t": "Local privacy check before sending", "a": "Agents"}, {"id": 185, "Roadmap": "Next", "t": "The main agent edits your pages in place", "a": "Agents"}, {"id": 192, "Roadmap": "Next", "t": "Based Cloud on EU servers", "a": "Sync"}, {"id": 193, "Roadmap": "Next", "t": "End-to-end encrypted sync", "a": "Sync"}, {"id": 3, "Roadmap": "Later", "t": "Sub-items in databases", "a": "Databases"}, {"id": 12, "Roadmap": "Later", "t": "Real-time collaboration", "a": "Workspace"}, {"id": 80, "Roadmap": "Later", "t": "iPhone, iPad and Android", "a": "Mobile and apps"}, {"id": 85, "Roadmap": "Later", "t": "Database automations", "a": "Databases"}, {"id": 87, "Roadmap": "Later", "t": "Daily notes", "a": "Workspace"}, {"id": 90, "Roadmap": "Later", "t": "Wikilinks while you type", "a": "Workspace"}, {"id": 92, "Roadmap": "Later", "t": "PDF reading and annotation", "a": "Workspace"}, {"id": 93, "Roadmap": "Later", "t": "Whiteboard", "a": "Workspace"}, {"id": 194, "Roadmap": "Later", "t": "Windows and Linux", "a": "Mobile and apps"}]/*END*/;
    const cols = [['shipped', 'Shipped', 'Working in the prototype'], ['now', 'Now', 'Being built this month'], ['next', 'Next', 'Up after that'], ['later', 'Later', 'On the list']];
    return cols.map(([id, t, sub]) => ({ id, t, sub, items: rows.filter((r) => r.Roadmap === t).map((r) => [r.t, r.a]) }))
      .concat([{ id: 'ideas', t: 'Ideas from you', sub: 'Suggested by visitors', items: [] }]);
  }
  renderVals() {
    const theme = this.props.theme ?? 'light';
    const dark = theme === 'dark';
    const s = this.state;
    const areaList = ['All', 'Workspace', 'Databases', 'Agents', 'Sync', 'Mobile and apps'];
    const cols = Component.data().map((c) => {
      const raw = c.id === 'ideas' ? s.ideas.map((x) => [x.t, x.area, x.key]) : c.items;
      const items = raw.filter((it) => s.area === 'All' || it[1] === s.area).map((it) => {
        const key = it[2] || (c.id + ':' + it[0]);
        const voted = !!s.votes[key];
        const base = c.id === 'ideas' ? 1 : 0;
        const n = base + (voted ? 1 : 0);
        return {
          t: it[0], area: it[1], votes: n > 0 ? String(n) : 'Vote', voted: voted ? 'true' : 'false',
          aria: (voted ? 'Remove vote for ' : 'Vote for ') + it[0],
          vbg: voted ? 'var(--button)' : 'var(--surface-raised)', vfg: voted ? 'var(--button-ink)' : 'var(--ink)',
          vote: () => this.setState({ votes: Object.assign({}, s.votes, { [key]: !voted }) })
        };
      });
      return {
        t: c.t, sub: c.sub, n: String(items.length), items,
        bg: c.id === 'now' ? 'var(--marker)' : 'var(--surface-raised)',
        empty: items.length === 0,
        emptyText: c.id === 'ideas' ? 'Nothing here yet. Be the first: suggest something below.' : 'Nothing in this area right now.'
      };
    });
    return {
      theme,
      markSrc: dark ? '/_blob/60426240b69c9dab9372c2741257d898' : '/_blob/c3ccc021887376abcf7fe08d0002d913',
      hw: Component.words('Build it with us.', 0, 120),
      areas: areaList.map((a) => ({ label: a, on: s.area === a ? 'true' : 'false', bg: s.area === a ? 'var(--button)' : 'var(--surface-raised)', fg: s.area === a ? 'var(--button-ink)' : 'var(--ink)', pick: () => this.setState({ area: a }) })),
      cols,
      draft: s.draft,
      setDraft: (e) => this.setState({ draft: e.target.value, thanks: false }),
      draftAreas: areaList.slice(1).map((a) => ({ label: a, on: s.draftArea === a ? 'true' : 'false', bg: s.draftArea === a ? 'var(--button)' : 'var(--bg)', fg: s.draftArea === a ? 'var(--button-ink)' : 'var(--ink)', pick: () => this.setState({ draftArea: a }) })),
      submit: (e) => {
        e.preventDefault();
        const t = s.draft.trim();
        if (!t) return;
        const key = 'idea:' + Date.now();
        this.setState({ ideas: [{ t, area: s.draftArea, key }].concat(s.ideas), draft: '', thanks: true, area: 'All' });
      },
      thanks: s.thanks
    };
  }
}
