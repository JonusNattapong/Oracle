export function renderControlCenterDashboard(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>Oracle Control Center</title>
  <style>
    :root {
      --bg: #07111f;
      --panel: #0d1b2d;
      --panel-2: #10243d;
      --line: #1f3b5d;
      --text: #edf6ff;
      --muted: #8ea9c4;
      --blue: #38a3ff;
      --blue-2: #1677d2;
      --green: #3ddc97;
      --amber: #f7b955;
      --red: #ff6680;
      --shadow: 0 18px 55px rgba(0,0,0,.28);
    }
    body.light {
      --bg: #edf5fc;
      --panel: #ffffff;
      --panel-2: #f2f8fd;
      --line: #c9dcee;
      --text: #10243d;
      --muted: #58718b;
      --shadow: 0 16px 45px rgba(23,74,120,.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      background:
        radial-gradient(circle at 8% 0%, rgba(28,125,214,.18), transparent 30%),
        radial-gradient(circle at 92% 10%, rgba(41,173,255,.12), transparent 28%),
        var(--bg);
      font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button, input { font: inherit; }
    .shell { max-width: 1540px; margin: 0 auto; padding: 24px; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-bottom: 22px; }
    .brand { display: flex; align-items: center; gap: 14px; }
    .mark {
      width: 44px; height: 44px; display: grid; place-items: center;
      border: 1px solid #2f7fbd; border-radius: 14px;
      background: linear-gradient(145deg,#0b2944,#146bb1);
      color: white; box-shadow: 0 12px 30px rgba(16,112,183,.28);
      font-size: 21px; font-weight: 800;
    }
    h1 { margin: 0; font-size: clamp(20px,2vw,28px); letter-spacing: -.02em; }
    .subtitle { color: var(--muted); margin-top: 2px; }
    .actions { display: flex; align-items: center; gap: 9px; }
    .status { display: flex; align-items: center; gap: 7px; color: var(--muted); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--amber); box-shadow: 0 0 0 5px rgba(247,185,85,.11); }
    .dot.live { background: var(--green); box-shadow: 0 0 0 5px rgba(61,220,151,.11); }
    #updated { color: var(--muted); font-size: 12px; }
    .button {
      border: 1px solid var(--line); color: var(--text); background: var(--panel);
      border-radius: 10px; padding: 8px 12px; cursor: pointer;
    }
    .button:hover { border-color: var(--blue); }
    .button.primary { background: var(--blue-2); border-color: var(--blue-2); color: white; }
    .button.danger { border-color: rgba(255,102,128,.5); color: var(--red); }
    .button.mini { padding: 4px 9px; border-radius: 8px; font-size: 12px; }
    .filter-input {
      background: var(--panel); border: 1px solid var(--line); color: var(--text);
      border-radius: 8px; padding: 6px 10px; width: 200px;
    }
    .filter-input:focus { outline: none; border-color: var(--blue); }
    .notice {
      display: none; margin-bottom: 18px; padding: 13px 15px; border: 1px solid rgba(247,185,85,.45);
      border-radius: 12px; color: var(--amber); background: rgba(247,185,85,.08);
    }
    .kpis { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 14px; margin-bottom: 14px; }
    .card {
      background: linear-gradient(160deg,var(--panel),var(--panel-2));
      border: 1px solid var(--line); border-radius: 16px; box-shadow: var(--shadow);
    }
    .kpi { padding: 17px 18px; position: relative; overflow: hidden; }
    .kpi::after { content: ""; position: absolute; right: -28px; top: -35px; width: 100px; height: 100px; border-radius: 50%; background: rgba(56,163,255,.08); }
    .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
    .value { margin-top: 8px; font-size: 28px; font-weight: 750; letter-spacing: -.04em; }
    .hint { color: var(--muted); font-size: 12px; margin-top: 2px; }
    .grid { display: grid; grid-template-columns: minmax(0,1.35fr) minmax(360px,.65fr); gap: 14px; }
    .stack { display: grid; gap: 14px; align-content: start; }
    .section { padding: 18px; min-width: 0; }
    .section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    .section-tools { display: flex; align-items: center; gap: 8px; }
    h2 { margin: 0; font-size: 16px; }
    .badge { display: inline-flex; align-items: center; border-radius: 99px; padding: 3px 8px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; background: rgba(56,163,255,.12); color: var(--blue); }
    .badge.high { color: var(--red); background: rgba(255,102,128,.1); }
    .badge.medium { color: var(--amber); background: rgba(247,185,85,.1); }
    .badge.low { color: var(--green); background: rgba(61,220,151,.1); }
    .badge.ok { color: var(--green); background: rgba(61,220,151,.1); }
    .badge.bad { color: var(--red); background: rgba(255,102,128,.1); }
    .badge.paused { color: var(--amber); background: rgba(247,185,85,.1); }
    .approval-list { display: grid; gap: 9px; max-height: 365px; overflow: auto; padding-right: 3px; }
    .approval { padding: 13px; border: 1px solid var(--line); border-radius: 12px; background: rgba(7,17,31,.15); }
    .approval-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .approval-title { font-weight: 700; }
    .approval-meta { color: var(--muted); font-size: 12px; margin-top: 5px; }
    .approval-actions { display: flex; gap: 7px; margin-top: 11px; }
    .empty { color: var(--muted); padding: 26px 8px; text-align: center; border: 1px dashed var(--line); border-radius: 12px; }
    .task-flow { display: grid; grid-template-columns: repeat(6,minmax(84px,1fr)); gap: 8px; margin-bottom: 15px; }
    .lane { padding: 11px 10px; border-radius: 11px; background: rgba(56,163,255,.06); border: 1px solid var(--line); }
    .lane strong { display: block; margin-top: 5px; font-size: 20px; }
    .table-wrap { overflow: auto; }
    table { width: 100%; border-collapse: collapse; white-space: nowrap; }
    th, td { text-align: left; border-bottom: 1px solid var(--line); padding: 9px 7px; }
    th { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
    td.title { max-width: 320px; overflow: hidden; text-overflow: ellipsis; font-weight: 620; }
    td.actions-cell { text-align: right; }
    td.actions-cell .button { margin-left: 5px; }
    .bars { display: grid; gap: 10px; }
    .bar-row { display: grid; grid-template-columns: 84px 1fr 34px; gap: 9px; align-items: center; }
    .track { height: 8px; border-radius: 99px; background: rgba(142,169,196,.14); overflow: hidden; }
    .fill { height: 100%; border-radius: inherit; background: linear-gradient(90deg,var(--blue-2),var(--blue)); min-width: 2px; }
    .agent-row { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--line); }
    .agent-row:last-child { border-bottom: none; }
    .presence { width: 8px; height: 8px; border-radius: 50%; flex: none; }
    .presence.on { background: var(--green); box-shadow: 0 0 0 4px rgba(61,220,151,.11); }
    .presence.off { background: var(--muted); }
    .agent-name { font-weight: 650; }
    .agent-meta { color: var(--muted); font-size: 12px; margin-left: auto; }
    .timeline { display: grid; gap: 11px; max-height: 365px; overflow: auto; }
    .event { display: grid; grid-template-columns: 10px 1fr; gap: 10px; }
    .event i { width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; background: var(--blue); box-shadow: 0 0 0 4px rgba(56,163,255,.1); }
    .event.denied i { background: var(--red); box-shadow: 0 0 0 4px rgba(255,102,128,.1); }
    .event small { color: var(--muted); }
    .workspace { max-width: min(46vw,620px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #toasts { position: fixed; right: 18px; bottom: 18px; display: grid; gap: 8px; z-index: 50; max-width: min(92vw,440px); }
    .toast { padding: 11px 14px; border-radius: 11px; border: 1px solid rgba(61,220,151,.5); background: var(--panel); box-shadow: var(--shadow); font-size: 13px; }
    .toast.error { border-color: rgba(255,102,128,.5); color: var(--red); }
    @media (max-width: 980px) {
      .kpis { grid-template-columns: repeat(2,minmax(0,1fr)); }
      .grid { grid-template-columns: 1fr; }
      .task-flow { grid-template-columns: repeat(3,minmax(0,1fr)); }
      .workspace { max-width: 75vw; }
    }
    @media (max-width: 560px) {
      .shell { padding: 15px; }
      header { align-items: flex-start; }
      .actions .status, #updated { display: none; }
      .kpis { grid-template-columns: 1fr 1fr; gap: 9px; }
      .value { font-size: 23px; }
      .section { padding: 14px; }
      .task-flow { grid-template-columns: repeat(2,minmax(0,1fr)); }
      .filter-input { width: 130px; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div class="brand">
        <div class="mark">O</div>
        <div>
          <h1>Oracle Control Center</h1>
          <div class="subtitle workspace" id="workspace">Connecting to local Runtime…</div>
        </div>
      </div>
      <div class="actions">
        <span id="updated"></span>
        <span class="status"><span class="dot" id="live-dot"></span><span id="live-text">offline</span></span>
        <button class="button" id="theme" type="button">Theme</button>
        <button class="button" id="refresh" type="button">Refresh</button>
      </div>
    </header>

    <div class="notice" id="notice">
      Missing local access token. Open this page using <code>oracle control url</code>.
    </div>

    <section class="kpis">
      <article class="card kpi"><div class="label">Approval inbox</div><div class="value" id="approval-count">—</div><div class="hint" id="approval-hint">pending decisions</div></article>
      <article class="card kpi"><div class="label">Active tasks</div><div class="value" id="task-count">—</div><div class="hint" id="task-hint">across agent workflows</div></article>
      <article class="card kpi"><div class="label">Project memory</div><div class="value" id="memory-count">—</div><div class="hint" id="memory-hint">persistent entries</div></article>
      <article class="card kpi"><div class="label">Policy denials</div><div class="value" id="denial-count">—</div><div class="hint" id="audit-hint">recent audit window</div></article>
    </section>

    <div class="grid">
      <div class="stack">
        <section class="card section">
          <div class="section-head">
            <h2>Approval inbox</h2>
            <div class="section-tools">
              <input class="filter-input" id="approval-filter" type="text" placeholder="Filter approvals…">
              <span class="badge" id="approval-badge">0 pending</span>
            </div>
          </div>
          <div class="approval-list" id="approvals"><div class="empty">Loading approvals…</div></div>
        </section>

        <section class="card section">
          <div class="section-head"><h2>Task workflow</h2><span class="badge" id="task-total">0 tasks</span></div>
          <div class="task-flow" id="task-flow"></div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Status</th><th>Task</th><th>Owner → Agent</th><th>Updated</th><th></th></tr></thead>
              <tbody id="tasks"></tbody>
            </table>
          </div>
        </section>

        <section class="card section">
          <div class="section-head"><h2>Scheduler</h2><span class="badge" id="scheduler-total">0 jobs</span></div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Status</th><th>Name</th><th>Cron</th><th>Last run</th><th></th></tr></thead>
              <tbody id="schedules"></tbody>
            </table>
          </div>
        </section>
      </div>

      <div class="stack">
        <section class="card section">
          <div class="section-head">
            <h2>Memory distribution</h2>
            <div class="section-tools">
              <button class="button mini" id="maintenance" type="button">Run maintenance</button>
              <span class="badge" id="global-memory">0 global</span>
            </div>
          </div>
          <div class="bars" id="memory-bars"></div>
        </section>

        <section class="card section">
          <div class="section-head"><h2>Agents</h2><span class="badge" id="agents-total">0 active</span></div>
          <div id="agents"><div class="empty">No registered agents</div></div>
        </section>

        <section class="card section">
          <div class="section-head">
            <h2>Audit activity</h2>
            <div class="section-tools">
              <span class="badge ok" id="audit-integrity">chain</span>
              <span class="badge" id="audit-total">0 events</span>
            </div>
          </div>
          <div class="timeline" id="audit"></div>
        </section>
      </div>
    </div>
  </main>
  <div id="toasts"></div>

  <script>
    (() => {
      const hash = new URLSearchParams(location.hash.slice(1));
      const token = hash.get("token") || sessionStorage.getItem("oracle-runtime-token");
      if (hash.get("token")) {
        sessionStorage.setItem("oracle-runtime-token", hash.get("token"));
        history.replaceState(null, "", location.pathname + location.search);
      }
      const $ = (id) => document.getElementById(id);
      const esc = (value) => String(value ?? "")
        .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
      const shortTime = (value) => value ? new Date(value).toLocaleString() : "—";
      const shortAge = (value) => {
        if (!value) return "—";
        const time = Date.parse(value);
        if (Number.isNaN(time)) return "—";
        const elapsed = Math.max(0, Date.now() - time);
        if (elapsed < 60000) return Math.floor(elapsed / 1000) + "s";
        if (elapsed < 3600000) return Math.floor(elapsed / 60000) + "m";
        if (elapsed < 86400000) return Math.floor(elapsed / 3600000) + "h";
        return Math.floor(elapsed / 86400000) + "d";
      };
      const headers = () => ({ authorization: "Bearer " + token, "content-type": "application/json" });
      let snapshot;
      let approvalQuery = "";

      if (!token) $("notice").style.display = "block";
      $("theme").onclick = () => document.body.classList.toggle("light");
      $("refresh").onclick = () => load();

      function toast(message, kind) {
        const el = document.createElement("div");
        el.className = "toast" + (kind === "error" ? " error" : "");
        el.textContent = message;
        $("toasts").appendChild(el);
        setTimeout(() => el.remove(), 4500);
      }

      async function request(path, init = {}) {
        const response = await fetch(path, { ...init, headers: { ...headers(), ...(init.headers || {}) } });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || ("HTTP " + response.status));
        return body;
      }

      async function act(failLabel, fn) {
        try {
          await fn();
        } catch (error) {
          toast(failLabel + ": " + (error && error.message ? error.message : error), "error");
        }
      }

      async function decide(id, decision) {
        const item = snapshot?.approvals?.items?.find((candidate) => candidate.id === id);
        if (!item) { toast("Approval is no longer in the pending snapshot.", "error"); return; }
        const actor = prompt("Decision maker:", item.assignedTo);
        if (!actor) return;
        const note = decision === "reject" ? (prompt("Reason for rejection:") || "Rejected from Control Center") : undefined;
        if (!confirm((decision === "approve" ? "Approve " : "Reject ") + id + "?")) return;
        await act("Decision failed", async () => {
          const body = await request("/v1/control/approvals/" + encodeURIComponent(id) + "/decision", {
            method: "POST",
            body: JSON.stringify({
              decision,
              decidedBy: actor,
              expectedVersion: item.version,
              channel: "dashboard",
              note
            })
          });
          const updated = body.approval;
          toast(updated.status === "pending"
            ? "Vote recorded (" + updated.approvalCount + "/" + updated.requiredApprovals + ")."
            : "Approval " + updated.status + ".");
          await load();
        });
      }

      async function taskAction(id, action) {
        const task = snapshot?.tasks?.recent?.find((candidate) => candidate.id === id);
        const actorDefault = action === "submit" ? (task?.assignee ?? "") : (task?.createdBy ?? "");
        const actor = prompt(action === "submit" ? "Submit for review as:" : "Close task as:", actorDefault);
        if (!actor) return;
        if (!confirm((action === "submit" ? "Submit for review: " : "Approve and close: ") + id + "?")) return;
        await act("Task action failed", async () => {
          await request("/v1/control/tasks/" + encodeURIComponent(id) + "/" + action, {
            method: "POST",
            body: JSON.stringify({ actor })
          });
          toast(action === "submit" ? "Task submitted for review." : "Task approved and closed.");
          await load();
        });
      }

      async function scheduleRun(id) {
        if (!confirm("Run " + id + " now?")) return;
        await act("Run failed", async () => {
          const result = await request("/v1/schedules/" + encodeURIComponent(id) + "/run", { method: "POST" });
          if (result.result === "success") toast("Run completed.");
          else toast("Run failed: " + String(result.output || "").slice(0, 160), "error");
          await load();
        });
      }

      async function scheduleToggle(id, status) {
        const next = status === "active" ? "paused" : "active";
        await act("Update failed", async () => {
          await request("/v1/schedules/" + encodeURIComponent(id), {
            method: "PATCH",
            body: JSON.stringify({ status: next })
          });
          toast("Schedule " + next + ".");
          await load();
        });
      }

      async function scheduleDelete(id) {
        if (!confirm("Delete schedule " + id + "?")) return;
        await act("Delete failed", async () => {
          await request("/v1/schedules/" + encodeURIComponent(id), { method: "DELETE" });
          toast("Schedule deleted.");
          await load();
        });
      }

      $("maintenance").onclick = () => act("Maintenance failed", async () => {
        const body = await request("/v1/control/memory/maintenance", { method: "POST" });
        const project = body.result?.project ?? { pruned: [], promoted: [] };
        const global = body.result?.global ?? { pruned: [], promoted: [] };
        toast("Maintenance done — project pruned " + project.pruned.length + ", promoted "
          + project.promoted.length + "; global pruned " + global.pruned.length
          + ", promoted " + global.promoted.length + ".");
        await load();
      });

      $("approval-filter").oninput = (event) => {
        approvalQuery = event.target.value.trim().toLowerCase();
        if (snapshot) renderApprovals(snapshot);
      };

      function taskActionButton(task) {
        if (task.status === "review") {
          return '<button class="button mini primary" data-task-action="close" data-id="' + esc(task.id) + '">Close</button>';
        }
        if (task.status === "pending" || task.status === "in_progress" || task.status === "blocked") {
          return '<button class="button mini" data-task-action="submit" data-id="' + esc(task.id) + '">Submit</button>';
        }
        return "";
      }

      function renderApprovals(data) {
        const items = approvalQuery
          ? data.approvals.items.filter((item) =>
              [item.id, item.title, item.requestedBy, item.assignedTo, item.risk]
                .some((value) => String(value ?? "").toLowerCase().includes(approvalQuery)))
          : data.approvals.items;
        $("approvals").innerHTML = items.length ? items.map((item) => \`
          <article class="approval">
            <div class="approval-top">
              <div><div class="approval-title">\${esc(item.title)}</div><div class="approval-meta">\${esc(item.requestedBy)} → \${esc(item.assignedTo)} · \${esc(item.kind)} · quorum \${item.approvalCount}/\${item.requiredApprovals} · v\${item.version}</div></div>
              <span class="badge \${esc(item.risk)}">\${esc(item.risk)}</span>
            </div>
            \${item.description ? '<div class="approval-meta">' + esc(item.description) + '</div>' : ''}
            \${item.expiresAt ? '<div class="approval-meta">Expires ' + esc(shortTime(item.expiresAt)) + '</div>' : ''}
            <div class="approval-actions">
              <button class="button primary" data-decision="approve" data-id="\${esc(item.id)}">Approve</button>
              <button class="button danger" data-decision="reject" data-id="\${esc(item.id)}">Reject</button>
            </div>
          </article>\`).join("") : '<div class="empty">' + (approvalQuery ? "No approvals match the filter" : "No pending approvals") + '</div>';
        document.querySelectorAll("[data-decision]").forEach((button) => {
          button.onclick = () => decide(button.dataset.id, button.dataset.decision);
        });
      }

      function render(data) {
        snapshot = data;
        $("workspace").textContent = data.workspaceRoot + " · Runtime " + data.version;
        $("approval-count").textContent = data.approvals.pending;
        $("approval-hint").textContent = data.approvals.byRisk.high + " high risk · " + data.approvals.byRisk.medium + " medium";
        $("task-count").textContent = data.tasks.active;
        $("task-hint").textContent = data.tasks.total + " total tasks";
        $("memory-count").textContent = data.memory.project.total;
        $("memory-hint").textContent = data.memory.global.total + " global entries";
        $("denial-count").textContent = data.audit.policyDenials;
        $("audit-hint").textContent = data.audit.integrity.valid
          ? data.audit.integrity.verifiedEntries + " chain entries verified"
          : "audit integrity failure at " + data.audit.integrity.brokenAt;
        $("approval-badge").textContent = data.approvals.pending + " pending";
        $("task-total").textContent = data.tasks.total + " tasks";
        $("global-memory").textContent = data.memory.global.total + " global";
        $("audit-total").textContent = data.audit.total + " events";
        const integrity = $("audit-integrity");
        integrity.textContent = data.audit.integrity.valid ? "chain valid" : "broken @ " + data.audit.integrity.brokenAt;
        integrity.className = "badge " + (data.audit.integrity.valid ? "ok" : "bad");
        $("scheduler-total").textContent = data.schedules.length + " jobs";
        $("agents-total").textContent = data.agents.active + " active";
        tickUpdated(data.generatedAt);

        renderApprovals(data);

        const labels = { pending: "Pending", in_progress: "In progress", review: "Review", done: "Done", blocked: "Blocked", cancelled: "Cancelled" };
        $("task-flow").innerHTML = Object.entries(data.tasks.byStatus).map(([status,count]) =>
          '<div class="lane"><span class="label">' + esc(labels[status] || status) + '</span><strong>' + count + '</strong></div>'
        ).join("");
        $("tasks").innerHTML = data.tasks.recent.slice(0,12).map((task) => \`
          <tr><td><span class="badge">\${esc(task.status)}</span></td><td class="title">\${esc(task.title)}</td><td>\${esc(task.createdBy)} → \${esc(task.assignee)}</td><td>\${esc(shortTime(task.updatedAt))}</td><td class="actions-cell">\${taskActionButton(task)}</td></tr>
        \`).join("") || '<tr><td colspan="5" class="empty">No tasks yet</td></tr>';
        document.querySelectorAll("[data-task-action]").forEach((button) => {
          button.onclick = () => taskAction(button.dataset.id, button.dataset.taskAction);
        });

        $("schedules").innerHTML = data.schedules.slice(0,12).map((job) => \`
          <tr>
            <td><span class="badge \${job.status === "active" ? "ok" : "paused"}">\${esc(job.status)}</span></td>
            <td class="title">\${esc(job.name)}</td>
            <td><code>\${esc(job.cron)}</code></td>
            <td>\${job.lastRunAt ? esc(shortAge(job.lastRunAt)) + " ago" + (job.lastResult === "error" ? " ✗" : "") : "—"}</td>
            <td class="actions-cell">
              <button class="button mini" data-schedule-action="run" data-id="\${esc(job.id)}">Run</button>
              <button class="button mini" data-schedule-action="toggle" data-status="\${esc(job.status)}" data-id="\${esc(job.id)}">\${job.status === "active" ? "Pause" : "Resume"}</button>
              <button class="button mini danger" data-schedule-action="delete" data-id="\${esc(job.id)}">Delete</button>
            </td>
          </tr>\`).join("") || '<tr><td colspan="5" class="empty">No scheduled jobs</td></tr>';
        document.querySelectorAll("[data-schedule-action]").forEach((button) => {
          button.onclick = () => {
            const action = button.dataset.scheduleAction;
            if (action === "run") void scheduleRun(button.dataset.id);
            else if (action === "toggle") void scheduleToggle(button.dataset.id, button.dataset.status);
            else if (action === "delete") void scheduleDelete(button.dataset.id);
          };
        });

        $("agents").innerHTML = data.agents.items.length ? data.agents.items.slice(0,12).map((agent) => \`
          <div class="agent-row">
            <span class="presence \${agent.active ? "on" : "off"}"></span>
            <span class="agent-name">\${esc(agent.name)}</span>
            <span class="agent-meta">\${esc(agent.role ?? "—")} · \${esc(shortAge(agent.lastSeen))} ago</span>
          </div>\`).join("") : '<div class="empty">No registered agents</div>';

        const memory = data.memory.project.byType;
        const maxMemory = Math.max(1, ...Object.values(memory));
        $("memory-bars").innerHTML = Object.entries(memory).sort((a,b) => b[1]-a[1]).map(([type,count]) => \`
          <div class="bar-row"><span>\${esc(type)}</span><div class="track"><div class="fill" style="width:\${Math.max(3,(count/maxMemory)*100)}%"></div></div><strong>\${count}</strong></div>
        \`).join("") || '<div class="empty">No project memory yet</div>';

        $("audit").innerHTML = data.audit.recent.slice(0,16).map((event) => \`
          <div class="event \${event.action === "policy_denied" ? "denied" : ""}"><i></i><div><strong>\${esc(event.action)}</strong> · \${esc(event.target)}<br><small>\${esc(event.agentId || "?")} · \${esc(shortTime(event.timestamp))}</small></div></div>
        \`).join("") || '<div class="empty">No audit events yet</div>';
      }

      let lastGeneratedAt;
      function tickUpdated(generatedAt) {
        if (generatedAt) lastGeneratedAt = generatedAt;
        $("updated").textContent = lastGeneratedAt ? "Updated " + shortAge(lastGeneratedAt) + " ago" : "";
      }
      setInterval(() => tickUpdated(), 5000);

      async function load() {
        if (!token) return;
        try {
          render(await request("/v1/control/snapshot"));
          $("live-dot").classList.add("live");
          $("live-text").textContent = "live";
          $("notice").style.display = "none";
        } catch (error) {
          $("live-dot").classList.remove("live");
          $("live-text").textContent = "offline";
          $("notice").textContent = error.message;
          $("notice").style.display = "block";
        }
      }

      let reloadTimer;
      function scheduleReload() {
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(load, 250);
      }

      function connectEvents() {
        if (!token) return;
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        const socket = new WebSocket(protocol + "//" + location.host + "/v1/events?token=" + encodeURIComponent(token));
        socket.onopen = () => {
          $("live-dot").classList.add("live");
          $("live-text").textContent = "live";
        };
        socket.onmessage = scheduleReload;
        socket.onclose = () => {
          $("live-dot").classList.remove("live");
          $("live-text").textContent = "offline";
          setTimeout(connectEvents, 2000);
        };
      }

      load();
      connectEvents();
      setInterval(load, 10000);
    })();
  </script>
</body>
</html>`;
}
