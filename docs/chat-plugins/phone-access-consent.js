// 小手机聊天插件 · 「TA 动我的手机」
// 安装：聊天设置 →「扩展插件」→ 粘贴本文件全文 → 安装
// 卸载/禁用即时生效，无需刷新页面，无需重新部署。
//
// 能力边界（务必先看）：
//   插件接口只能「读」会话与联系人，不能改备注、不能置顶、不能拉黑；
//   朋友圈没有开放接口。所以本插件只实现三个动作：
//     1) 在你的对话里替你打字
//     2) 以你的名义给别人发消息
//     3) 以你的名义替某个人回怼
//   其余动作需要改应用本体源码，插件做不到。

const LS_LOGS = "access_logs";
const LS_LOCKS = "locked_sessions";

const ACTION_TEXT = {
  type: "在你的对话里替你打字",
  send: "以你的名义给别人发消息",
  reply: "以你的名义替别人回一句话",
};

const DIRECTIVE_RE = /\[动手机[:：]\s*(打字|发消息|回怼)\s*[:：]?\s*(\{[\s\S]*?\})\]/;
const KIND_MAP = { 打字: "type", 发消息: "send", 回怼: "reply" };

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

function clockText(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return (d.getMonth() + 1) + "/" + d.getDate() + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

export default {
  manifest: {
    id: "phone-access-consent",
    name: "TA 动我的手机",
    apiVersion: 1,
    version: "1.0.0",
    author: "小坊",
    description: "让角色有限度地操作你的小手机：替你在对话里打字、以你的名义发消息。每次动手前有几秒可以拦住，事后可一键撤回。",
    permissions: ["chat.read", "chat.write", "ui", "storage"],
    settings: [
      { key: "master", label: "总开关：允许 TA 动我的手机", type: "boolean", default: false, description: "关着时角色完全看不到这个能力，也不会往提示词里写任何内容。" },
      { key: "allowType", label: "允许替我在我们的对话里打字", type: "boolean", default: true },
      { key: "allowSend", label: "允许以我的名义给别人发消息", type: "boolean", default: false },
      { key: "allowReply", label: "允许以我的名义回怼别人", type: "boolean", default: false },
      { key: "countdown", label: "动手前的倒计时（秒）", type: "number", default: 8, description: "倒计时内你可以点「拦住」；不理它就自动执行。3~30 秒。" },
      { key: "promptFragment", label: "把「可操作手机」写进提示词", type: "boolean", default: true, description: "关掉后角色不会主动使用这个能力，但插件仍然可用（比如你自己在设置区手动触发）。" },
    ],
  },

  setup(ctx) {
    const S = ctx.system.settings;
    const st = ctx.system.storage;

    /* ---------------- 基础读写 ---------------- */

    const readLogs = () => {
      const v = st.get(LS_LOGS);
      return Array.isArray(v) ? v : [];
    };
    const writeLogs = (v) => st.set(LS_LOGS, v.slice(0, 200));

    const readLocks = () => {
      const v = st.get(LS_LOCKS);
      return Array.isArray(v) ? v : [];
    };
    const writeLocks = (v) => st.set(LS_LOCKS, v);

    const masterOn = () => S.get("master") === true;
    const countdownSeconds = () => {
      const n = Number(S.get("countdown"));
      if (!isFinite(n) || n <= 0) return 8;
      return Math.max(3, Math.min(30, Math.round(n)));
    };

    const enabledActions = () => {
      const out = [];
      if (S.get("allowType") !== false) out.push("type");
      if (S.get("allowSend") === true) out.push("send");
      if (S.get("allowReply") === true) out.push("reply");
      return out;
    };

    /* ---------------- 会话与名字 ---------------- */

    const allSessions = () => {
      try { return ctx.data.sessions.list() || []; } catch (e) { return []; }
    };
    const allCharacters = () => {
      try { return ctx.data.characters.list() || []; } catch (e) { return []; }
    };
    const allContacts = () => {
      try { return ctx.data.contacts.list() || []; } catch (e) { return []; }
    };

    const characterName = (id) => {
      const c = allCharacters().find((x) => x.id === id);
      return c && c.name ? c.name : "";
    };

    const sessionName = (session) => {
      if (!session) return "对方";
      if (session.isGroup) return session.groupName || "群聊";
      const contact = allContacts().find((c) => c.id === session.contactId);
      const charName = contact ? characterName(contact.characterId) : "";
      return session.alias || charName || (contact && contact.nickname) || "对方";
    };

    const visibleSessions = () => {
      const locks = readLocks();
      return allSessions().filter((s) => locks.indexOf(s.id) < 0);
    };

    const findSessionByName = (name) => {
      if (!name) return null;
      const list = visibleSessions().filter((s) => !s.isGroup);
      const exact = list.find((s) => sessionName(s) === name);
      if (exact) return exact;
      return list.find((s) => sessionName(s).indexOf(name) >= 0 || name.indexOf(sessionName(s)) >= 0) || null;
    };

    /* ---------------- 提示词片段 ---------------- */

    const buildFragment = () => {
      if (!masterOn()) return "";
      if (S.get("promptFragment") === false) return "";
      const acts = enabledActions();
      if (!acts.length) return "";

      const lines = [];
      lines.push("[手机操作权限：已开放]");
      lines.push("你可以直接操作对方的小手机。当前开放的动作：");
      if (acts.indexOf("type") >= 0) lines.push("- 打字：以对方的身份，在你们当前的对话里替对方打出一条消息");
      if (acts.indexOf("send") >= 0) lines.push("- 发消息：以对方的身份，给对方的某个联系人发一条消息");
      if (acts.indexOf("reply") >= 0) lines.push("- 回怼：以对方的身份，替对方回一句强硬的话给某个联系人");

      lines.push("");
      lines.push("写法：单独占一行，一次只写一条，不要和别的内容挤在同一行：");
      if (acts.indexOf("type") >= 0) lines.push('[动手机:打字:{"content":"要打的字"}]');
      if (acts.indexOf("send") >= 0) lines.push('[动手机:发消息:{"target":"联系人名字","content":"要说的话"}]');
      if (acts.indexOf("reply") >= 0) lines.push('[动手机:回怼:{"target":"联系人名字","content":"要说的话"}]');

      lines.push("");
      const names = [];
      visibleSessions().filter((s) => !s.isGroup).forEach((s) => {
        const n = sessionName(s);
        if (n && names.indexOf(n) < 0) names.push(n);
      });
      if (names.length) lines.push("可以发给的联系人：" + names.slice(0, 30).join("、"));
      else lines.push("目前没有可以发给的联系人。");

      lines.push("");
      lines.push("规则：");
      lines.push("- 只有你确实想这么做时才写标记；不想做就完全不写，不需要解释。");
      lines.push("- 标记会被系统摘掉，换成一条提交给对方的确认提醒，对方可以在几秒内拦住。");
      lines.push("- 被拦住就是没做成，不要重试、不要换个说法绕过。");
      lines.push("- 日常对话用不到这个能力，不要滥用。");
      return lines.join("\n");
    };

    let currentFragment = "";
    const refreshFragment = () => {
      const next = buildFragment();
      if (next === currentFragment) return;
      currentFragment = next;
      try {
        if (next) ctx.prompts.set(next);
        else ctx.prompts.clear();
      } catch (e) {
        ctx.system.log("设置提示词片段失败", e);
      }
    };

    /* ---------------- 拦截浮层 ---------------- */

    const askConsent = (info) => new Promise((resolve) => {
      const total = countdownSeconds();
      let left = total;
      let settled = false;
      let ticker = null;
      let modalApi = null;
      let cardEl = null;

      const finish = (verdict) => {
        if (settled) return;
        settled = true;
        if (ticker) { try { ticker(); } catch (e) { /* ignore */ } ticker = null; }
        try { if (modalApi) modalApi.close(); } catch (e) { /* ignore */ }
        resolve(verdict);
      };

      try {
        modalApi = ctx.ui.openModal((el, api) => {
          modalApi = api;
          cardEl = el;
          el.innerHTML = "";
          el.style.padding = "0";

          const card = document.createElement("div");
          card.style.cssText = "padding:20px 18px 16px;font:14px/1.6 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;color:#1d1d1f;";

          const head = document.createElement("div");
          head.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:12px;";
          const dot = document.createElement("span");
          dot.style.cssText = "width:8px;height:8px;border-radius:50%;background:#ff3b30;flex:0 0 auto;";
          const title = document.createElement("div");
          title.style.cssText = "font-size:16px;font-weight:600;line-height:1.3;";
          title.textContent = info.charName + " 想动你的手机";
          head.appendChild(dot);
          head.appendChild(title);

          const badge = document.createElement("div");
          badge.style.cssText = "display:inline-block;font-size:12px;color:#8e5a00;background:rgba(255,159,10,.16);padding:3px 9px;border-radius:999px;margin-bottom:12px;";
          badge.textContent = ACTION_TEXT[info.kind] || "想动你的手机";

          const body = document.createElement("div");
          body.style.cssText = "background:#f7f7f9;border-radius:10px;padding:12px;margin-bottom:14px;white-space:pre-wrap;word-break:break-word;max-height:34vh;overflow:auto;";
          body.textContent = info.preview;

          const tip = document.createElement("div");
          tip.style.cssText = "font-size:12px;color:#86868b;margin-bottom:14px;";
          tip.textContent = "这次动作会记进撤销列表，事后可以一键撤回。";

          const cd = document.createElement("div");
          cd.style.cssText = "font-size:13px;color:#1d1d1f;font-weight:600;margin-bottom:12px;";
          cd.textContent = left + " 秒后自动执行";

          const row = document.createElement("div");
          row.style.cssText = "display:flex;gap:10px;";

          const blockBtn = document.createElement("button");
          blockBtn.textContent = "拦住";
          blockBtn.style.cssText = "flex:1;min-height:44px;border:none;border-radius:10px;background:#007aff;color:#fff;font-size:15px;font-weight:600;";
          blockBtn.onclick = () => finish("block");

          const allowBtn = document.createElement("button");
          allowBtn.textContent = "现在就同意";
          allowBtn.style.cssText = "flex:1;min-height:44px;border:none;border-radius:10px;background:#eef0f3;color:#1d1d1f;font-size:15px;font-weight:500;";
          allowBtn.onclick = () => finish("allow");

          row.appendChild(allowBtn);
          row.appendChild(blockBtn);

          card.appendChild(head);
          card.appendChild(badge);
          card.appendChild(body);
          card.appendChild(cd);
          card.appendChild(tip);
          card.appendChild(row);
          el.appendChild(card);

          const handle = ctx.system.timers.setInterval(() => {
            if (settled) return;
            // 用户点遮罩关掉了浮层：按「拦住」处理，绝不默默执行
            if (cardEl && !cardEl.isConnected()) { finish("block"); return; }
            left -= 1;
            if (left <= 0) {
              cd.textContent = "正在执行…";
              finish("timeout");
              return;
            }
            cd.textContent = left + " 秒后自动执行";
          }, 1000);
          ticker = () => handle();
        });
      } catch (e) {
        ctx.system.log("打开拦截浮层失败，按拦截处理", e);
        finish("block");
      }
    });

    /* ---------------- 执行与撤销 ---------------- */

    const pushAsUser = (sessionId, content) => ctx.data.messages.push({
      sessionId,
      role: "user",
      content,
      status: "sent",
      createdAt: new Date().toISOString(),
    });

    const recordLog = (found, session, who) => {
      const entry = {
        id: "al_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
        kind: found.kind,
        who: who || "角色",
        target: sessionName(session),
        sessionId: session.id,
        content: found.content,
        messageId: "",
        createdAt: new Date().toISOString(),
        reverted: false,
      };
      try {
        const msg = pushAsUser(session.id, found.content);
        if (msg && msg.id) entry.messageId = msg.id;
      } catch (e) {
        ctx.system.log("写入消息失败", e);
        return null;
      }
      const logs = readLogs();
      logs.unshift(entry);
      writeLogs(logs);
      return entry;
    };

    const revertLog = (entry) => {
      if (!entry || entry.reverted) return;
      try {
        if (entry.messageId) ctx.data.messages.update(entry.messageId, { isRetracted: true });
      } catch (e) {
        ctx.system.log("撤回失败", e);
      }
      const logs = readLogs();
      const target = logs.find((x) => x.id === entry.id);
      if (target) {
        target.reverted = true;
        target.revertedAt = new Date().toISOString();
      }
      writeLogs(logs);
      ctx.ui.toast("已撤回");
    };

    /* ---------------- 主拦截点 ---------------- */

    const handleResponse = async (p) => {
      if (!masterOn()) return p;
      if (!p || typeof p.text !== "string" || !p.text) return p;
      if (p.purpose && p.purpose !== "chat" && p.purpose !== "group_chat") return p;

      const m = DIRECTIVE_RE.exec(p.text);
      if (!m) return p;

      // 先把标记从正文里摘掉：无论后面同意、拦住还是超时，都不会漏到聊天里
      p.text = p.text.replace(m[0], "").replace(/\n{3,}/g, "\n\n").trim();

      const kind = KIND_MAP[m[1]];
      if (enabledActions().indexOf(kind) < 0) return p;

      let payload = {};
      try {
        payload = JSON.parse(m[2]);
      } catch (e) {
        try { payload = JSON.parse(m[2].replace(/[\u201c\u201d]/g, '"')); } catch (e2) { payload = {}; }
      }
      const content = String((payload && (payload.content || payload.text)) || "").trim();
      if (!content) return p;

      const targetName = String((payload && (payload.target || payload.name)) || "").trim();
      const currentSession = p.sessionId ? (allSessions().find((s) => s.id === p.sessionId) || null) : null;

      let session = null;
      if (kind === "type") {
        session = currentSession;
      } else {
        session = findSessionByName(targetName);
      }

      if (!session) {
        ctx.ui.toast("TA 想发消息，但没匹配到联系人，已跳过");
        return p;
      }

      // 上锁的会话：直接拒绝，不进拦截流程
      if (readLocks().indexOf(session.id) >= 0) {
        ctx.ui.toast("目标会话已上锁，动作被拒绝");
        return p;
      }

      const who = currentSession ? sessionName(currentSession) : "角色";
      const preview = kind === "type"
        ? "在你们的对话里，替你说：\n" + content
        : "以你的名义发给「" + sessionName(session) + "」：\n" + content;

      const verdict = await askConsent({ charName: who, kind, preview });
      if (verdict === "block") {
        ctx.ui.toast("已拦住，这次没动手");
        return p;
      }

      const entry = recordLog({ kind, content }, session, who);
      if (entry) {
        const done = kind === "type"
          ? "已替你在对话里打了字"
          : "已以你的名义发给「" + entry.target + "」";
        ctx.ui.toast(who + " " + done);
      }
      refreshFragment();
      return p;
    };

    ctx.hooks.transform("llm.response", handleResponse, { priority: 50, timeoutMs: 120000 });

    /* ---------------- 设置区：可见范围 + 撤销 ---------------- */

    const styleEl = document.createElement("style");
    styleEl.textContent = [
      ".pac-wrap{font:13px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;color:#1d1d1f;}",
      ".pac-title{font-size:14px;font-weight:600;margin:0 0 4px;}",
      ".pac-desc{font-size:12px;color:#86868b;margin:0 0 10px;}",
      ".pac-list{border:1px solid #e5e5e7;border-radius:10px;overflow:hidden;margin-bottom:18px;}",
      ".pac-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-top:1px solid #f0f0f2;}",
      ".pac-row:first-child{border-top:none;}",
      ".pac-row input{width:18px;height:18px;flex:0 0 auto;}",
      ".pac-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".pac-sub{font-size:12px;color:#86868b;}",
      ".pac-btn{min-height:32px;padding:0 12px;border:none;border-radius:8px;background:#007aff;color:#fff;font-size:13px;font-weight:600;}",
      ".pac-btn.ghost{background:#eef0f3;color:#1d1d1f;}",
      ".pac-btn:disabled{opacity:.45;}",
      ".pac-empty{padding:14px;text-align:center;color:#86868b;font-size:12px;}",
      ".pac-item{padding:10px 12px;border-top:1px solid #f0f0f2;}",
      ".pac-item:first-child{border-top:none;}",
      ".pac-item-top{display:flex;align-items:center;gap:8px;margin-bottom:4px;}",
      ".pac-item-who{font-weight:600;}",
      ".pac-item-time{font-size:12px;color:#86868b;margin-left:auto;}",
      ".pac-item-body{font-size:12px;color:#3a3a3c;word-break:break-word;white-space:pre-wrap;}",
      ".pac-item-foot{display:flex;align-items:center;gap:8px;margin-top:6px;}",
      ".pac-reverted{font-size:12px;color:#86868b;}",
    ].join("");
    const styleDisposable = ctx.ui.injectCSS(styleEl.textContent);

    const buildPanel = (el) => {
      el.innerHTML = "";
      const wrap = document.createElement("div");
      wrap.className = "pac-wrap";

      // 1) 谁可以看哪些会话
      const t1 = document.createElement("div");
      t1.className = "pac-title";
      t1.textContent = "谁能被看见（上锁的会话 TA 翻不到，也发不了消息）";
      const d1 = document.createElement("div");
      d1.className = "pac-desc";
      d1.textContent = "勾上 = 允许 TA 看到并能发消息；取消勾选 = 上锁。注意：这只管本插件。记忆库、设置这些要另外去「设置 → 聊天工具箱」把「本地资料库」关掉。";

      const list1 = document.createElement("div");
      list1.className = "pac-list";
      const sessions = allSessions();
      if (!sessions.length) {
        const empty = document.createElement("div");
        empty.className = "pac-empty";
        empty.textContent = "还没有会话";
        list1.appendChild(empty);
      } else {
        sessions.forEach((s) => {
          const row = document.createElement("label");
          row.className = "pac-row";
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = readLocks().indexOf(s.id) < 0;
          cb.onchange = () => {
            const locks = readLocks();
            const idx = locks.indexOf(s.id);
            if (cb.checked) {
              if (idx >= 0) locks.splice(idx, 1);
            } else if (idx < 0) {
              locks.push(s.id);
            }
            writeLocks(locks);
            refreshFragment();
            ctx.ui.toast(cb.checked ? "已允许 TA 看到这个会话" : "已上锁");
          };
          const name = document.createElement("div");
          name.className = "pac-name";
          name.textContent = sessionName(s);
          if (s.isGroup) {
            const sub = document.createElement("span");
            sub.className = "pac-sub";
            sub.textContent = " · 群聊";
            name.appendChild(sub);
          }
          row.appendChild(cb);
          row.appendChild(name);
          list1.appendChild(row);
        });
      }

      // 2) 撤销记录
      const t2 = document.createElement("div");
      t2.className = "pac-title";
      t2.textContent = "TA 动过的手（可撤回）";
      const d2 = document.createElement("div");
      d2.className = "pac-desc";
      d2.textContent = "撤回会把那条消息标记为「已撤回」。插件接口没有删除消息的能力，所以是撤回不是删除。";

      const list2 = document.createElement("div");
      list2.className = "pac-list";
      const renderLogs = () => {
        list2.innerHTML = "";
        const logs = readLogs();
        if (!logs.length) {
          const empty = document.createElement("div");
          empty.className = "pac-empty";
          empty.textContent = "还没有记录";
          list2.appendChild(empty);
          return;
        }
        logs.forEach((entry) => {
          const item = document.createElement("div");
          item.className = "pac-item";

          const top = document.createElement("div");
          top.className = "pac-item-top";
          const who = document.createElement("span");
          who.className = "pac-item-who";
          who.textContent = entry.who + " → " + entry.target;
          const time = document.createElement("span");
          time.className = "pac-item-time";
          time.textContent = clockText(entry.createdAt);
          top.appendChild(who);
          top.appendChild(time);

          const body = document.createElement("div");
          body.className = "pac-item-body";
          body.textContent = entry.content;

          const foot = document.createElement("div");
          foot.className = "pac-item-foot";
          if (entry.reverted) {
            const flag = document.createElement("span");
            flag.className = "pac-reverted";
            flag.textContent = "已撤回";
            foot.appendChild(flag);
          } else {
            const btn = document.createElement("button");
            btn.className = "pac-btn ghost";
            btn.textContent = "撤回";
            btn.onclick = () => {
              revertLog(entry);
              renderLogs();
            };
            foot.appendChild(btn);
          }

          item.appendChild(top);
          item.appendChild(body);
          item.appendChild(foot);
          list2.appendChild(item);
        });
      };
      renderLogs();

      wrap.appendChild(t1);
      wrap.appendChild(d1);
      wrap.appendChild(list1);
      wrap.appendChild(t2);
      wrap.appendChild(d2);
      wrap.appendChild(list2);
      el.appendChild(wrap);
    };

    const slotDisposable = ctx.ui.slot("settings.section", (el) => {
      const render = () => {
        try { buildPanel(el); } catch (e) { ctx.system.log("渲染设置区失败", e); }
      };
      render();
      const offSettings = S.onChange(() => render());
      const offSessions = ctx.hooks.on("session.opened", () => render());
      return () => {
        try { offSettings(); } catch (e) { /* ignore */ }
        try { offSessions(); } catch (e) { /* ignore */ }
      };
    });

    /* ---------------- 启动 ---------------- */

    refreshFragment();
    const offChange = S.onChange(() => refreshFragment());
    const offOpened = ctx.hooks.on("session.opened", () => refreshFragment());

    ctx.system.log("「TA 动我的手机」已加载，总开关：" + (masterOn() ? "开" : "关"));

    return () => {
      try { offChange(); } catch (e) { /* ignore */ }
      try { offOpened(); } catch (e) { /* ignore */ }
      try { styleDisposable(); } catch (e) { /* ignore */ }
      try { slotDisposable(); } catch (e) { /* ignore */ }
      try { ctx.prompts.clear(); } catch (e) { /* ignore */ }
    };
  },
};
