// lib/phone-access-storage.ts
// 「TA 动我的手机」——访问控制、动作配置、撤销日志。
//
// 设计原则（家用自用版）：
// 1. 总开关 default 关闭。关着时角色完全看不到这些工具。
// 2. 每个动作单独开关，用户可以只放开一部分。
// 3. 危险动作（删聊天、删好友、动钱）根本不在此列表内，不提供。
// 4. 会话可上锁：上锁的会话对任何 AI 都不可见（读不到、也翻不到）。
// 5. 每次动作写一条可撤销日志，用户可一键反向还原。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const ACCESS_CONFIG_KEY = "ai_phone_access_config_v1";
const ACCESS_LOG_KEY = "ai_phone_access_log_v1";

registerKvMigration(ACCESS_CONFIG_KEY);
registerKvMigration(ACCESS_LOG_KEY);

/* ---------------- 动作定义 ---------------- */

export type PhoneAccessActionId =
    | "like_my_moment"        // 在我的朋友圈底下点赞
    | "comment_my_moment"     // 在我的朋友圈底下留言
    | "rename_self_alias"     // 改掉 TA 自己在我这里的备注名
    | "pin_self"              // 把 TA 自己置顶
    | "type_in_our_chat"      // 替我在我们的对话里打字（以我的身份）
    | "send_message_as_user"  // 以我的名义给别人发消息
    | "reply_rude_to_others"  // 亲自回怼跟我聊天的人
    | "block_contact"         // 把某个人拉黑
    | "post_moment_as_user"   // 用我的账号发一条朋友圈
    | "rename_other_alias";   // 改掉我给别人取的备注

export type PhoneAccessActionMeta = {
    id: PhoneAccessActionId;
    /** 设置界面显示名 */
    label: string;
    /** 给 AI 的工具描述里用的说明 */
    description: string;
    /** 是否可在 v1 使用（未实现的动作先不暴露给模型） */
    implemented: boolean;
    /** 高危动作：默认关闭，且开启时额外提示 */
    risky?: boolean;
};

export const PHONE_ACCESS_ACTIONS: PhoneAccessActionMeta[] = [
    {
        id: "like_my_moment",
        label: "给我的朋友圈点赞",
        description: "给{{user}}发的朋友圈点赞。",
        implemented: true,
    },
    {
        id: "comment_my_moment",
        label: "在我的朋友圈底下留言",
        description: "在{{user}}发的朋友圈下面写一条留言，可以顺便回复已有的评论。",
        implemented: true,
    },
    {
        id: "rename_self_alias",
        label: "改掉 TA 自己在我这里的备注名",
        description: "修改{{user}}给角色自己设置的聊天备注名（只影响角色自己的备注）。",
        implemented: true,
    },
    {
        id: "pin_self",
        label: "把 TA 自己置顶",
        description: "把角色自己和{{user}}的会话置顶，或取消置顶。",
        implemented: true,
    },
    {
        id: "type_in_our_chat",
        label: "替我在我们的对话里打字",
        description: "以{{user}}的身份，在角色与{{user}}的会话里发出一条消息。",
        implemented: false,
        risky: true,
    },
    {
        id: "send_message_as_user",
        label: "以我的名义给别人发消息",
        description: "以{{user}}的身份，给其他会话发送消息。",
        implemented: false,
        risky: true,
    },
    {
        id: "reply_rude_to_others",
        label: "亲自回怼跟我聊天的人",
        description: "以{{user}}的身份，在别人的会话里回一句强硬的话。",
        implemented: false,
        risky: true,
    },
    {
        id: "block_contact",
        label: "把某个人拉黑",
        description: "把{{user}}的某个联系人拉黑。",
        implemented: false,
        risky: true,
    },
    {
        id: "post_moment_as_user",
        label: "用我的账号发一条朋友圈",
        description: "以{{user}}的身份发布一条朋友圈。",
        implemented: false,
        risky: true,
    },
    {
        id: "rename_other_alias",
        label: "改掉我给别人取的备注",
        description: "修改{{user}}给其他联系人设置的备注名。",
        implemented: false,
        risky: true,
    },
];

export function getPhoneAccessActionMeta(id: PhoneAccessActionId): PhoneAccessActionMeta | null {
    return PHONE_ACCESS_ACTIONS.find(item => item.id === id) ?? null;
}

/* ---------------- 可见范围 ---------------- */

export type PhoneAccessScopeId =
    | "chat"          // 聊天界面（聊天记录、联系人）
    | "moments"       // 朋友圈
    | "memory"        // 记忆库
    | "settings"      // 设置、预设、世界书、正则
    | "notewall"      // 便签墙
    | "assistant"     // 小卷 / 工坊 等助手会话
    | "custom_apps"   // 自定义 APP 数据
    | "calendar";     // 日历

export type PhoneAccessScopeMeta = {
    id: PhoneAccessScopeId;
    label: string;
    hint: string;
};

export const PHONE_ACCESS_SCOPES: PhoneAccessScopeMeta[] = [
    { id: "chat", label: "聊天界面", hint: "联系人、会话、聊天记录（上锁的会话仍会被排除）" },
    { id: "moments", label: "朋友圈", hint: "朋友圈内容、评论、点赞" },
    { id: "memory", label: "记忆库", hint: "核心记忆、长期记忆、事件流" },
    { id: "settings", label: "设置", hint: "预设、世界书、正则、API 配置等" },
    { id: "notewall", label: "便签墙", hint: "公共便签墙内容" },
    { id: "assistant", label: "AI 助手", hint: "与小卷、工坊的对话内容" },
    { id: "custom_apps", label: "自定义 APP", hint: "自定义 APP 的私有数据" },
    { id: "calendar", label: "日历", hint: "日程安排" },
];

/* ---------------- 配置类型 ---------------- */

export type PhoneAccessActionConfig = {
    enabled: boolean;
    /**
     * delay：先给用户 N 秒倒计时，期间可拦住，超时自动执行（默认）。
     * confirm：必须用户点「允许」才执行，不点就作废。
     */
    mode: "delay" | "confirm";
    /** delay 模式下的倒计时秒数 */
    delaySeconds: number;
};

export type PhoneAccessConfig = {
    /** 总开关：关着时角色完全看不到这些工具 */
    masterEnabled: boolean;
    actions: Record<PhoneAccessActionId, PhoneAccessActionConfig>;
    /** 可见范围：用户希望「只让 TA 看到聊天界面」时，只留 chat = true */
    scopes: Record<PhoneAccessScopeId, boolean>;
    /** 上锁的会话：对任何 AI 都不可见 */
    lockedSessionIds: string[];
    /** 上锁的角色：其会话同样不可见（按角色上锁，换设备/重建会话也生效） */
    lockedCharacterIds: string[];
    /** 撤销记录保留天数（0 = 永久保留） */
    undoRetentionDays: number;
};

const DEFAULT_ACTION_DELAY_SECONDS = 8;
const DEFAULT_RETENTION_DAYS = 30;

function defaultActions(): Record<PhoneAccessActionId, PhoneAccessActionConfig> {
    const result = {} as Record<PhoneAccessActionId, PhoneAccessActionConfig>;
    for (const meta of PHONE_ACCESS_ACTIONS) {
        result[meta.id] = {
            enabled: false,
            mode: "delay",
            delaySeconds: DEFAULT_ACTION_DELAY_SECONDS,
        };
    }
    return result;
}

function defaultScopes(): Record<PhoneAccessScopeId, boolean> {
    const result = {} as Record<PhoneAccessScopeId, boolean>;
    // 默认只开放聊天界面；其余全部关闭，符合「只让 TA 看到我的微信」。
    for (const scope of PHONE_ACCESS_SCOPES) {
        result[scope.id] = scope.id === "chat";
    }
    return result;
}

export function getDefaultPhoneAccessConfig(): PhoneAccessConfig {
    return {
        masterEnabled: false,
        actions: defaultActions(),
        scopes: defaultScopes(),
        lockedSessionIds: [],
        lockedCharacterIds: [],
        undoRetentionDays: DEFAULT_RETENTION_DAYS,
    };
}

/* ---------------- 配置读写 ---------------- */

function normalizeActionConfig(
    raw: Partial<PhoneAccessActionConfig> | undefined,
    fallback: PhoneAccessActionConfig,
): PhoneAccessActionConfig {
    const delay = Number(raw?.delaySeconds);
    return {
        enabled: raw?.enabled ?? fallback.enabled,
        mode: raw?.mode === "confirm" ? "confirm" : "delay",
        delaySeconds: Number.isFinite(delay)
            ? Math.max(3, Math.min(60, Math.floor(delay)))
            : fallback.delaySeconds,
    };
}

export function normalizePhoneAccessConfig(raw: unknown): PhoneAccessConfig {
    const defaults = getDefaultPhoneAccessConfig();
    if (!raw || typeof raw !== "object") return defaults;
    const input = raw as Partial<PhoneAccessConfig>;

    const actions = defaultActions();
    if (input.actions && typeof input.actions === "object") {
        for (const meta of PHONE_ACCESS_ACTIONS) {
            const item = (input.actions as Record<string, PhoneAccessActionConfig | undefined>)[meta.id];
            if (item) actions[meta.id] = normalizeActionConfig(item, actions[meta.id]);
        }
    }

    const scopes = defaultScopes();
    if (input.scopes && typeof input.scopes === "object") {
        for (const scope of PHONE_ACCESS_SCOPES) {
            const value = (input.scopes as Record<string, unknown>)[scope.id];
            if (typeof value === "boolean") scopes[scope.id] = value;
        }
    }

    const retention = Number(input.undoRetentionDays);

    return {
        masterEnabled: Boolean(input.masterEnabled),
        actions,
        scopes,
        lockedSessionIds: Array.isArray(input.lockedSessionIds)
            ? input.lockedSessionIds.filter((id): id is string => typeof id === "string" && Boolean(id))
            : [],
        lockedCharacterIds: Array.isArray(input.lockedCharacterIds)
            ? input.lockedCharacterIds.filter((id): id is string => typeof id === "string" && Boolean(id))
            : [],
        undoRetentionDays: Number.isFinite(retention)
            ? Math.max(0, Math.min(3650, Math.floor(retention)))
            : defaults.undoRetentionDays,
    };
}

export function loadPhoneAccessConfig(): PhoneAccessConfig {
    if (typeof window === "undefined") return getDefaultPhoneAccessConfig();
    try {
        const raw = kvGet(ACCESS_CONFIG_KEY);
        if (!raw) return getDefaultPhoneAccessConfig();
        return normalizePhoneAccessConfig(JSON.parse(raw));
    } catch {
        return getDefaultPhoneAccessConfig();
    }
}

export function savePhoneAccessConfig(config: PhoneAccessConfig): void {
    if (typeof window === "undefined") return;
    kvSet(ACCESS_CONFIG_KEY, JSON.stringify(normalizePhoneAccessConfig(config)));
}

/* ---------------- 会话上锁 ---------------- */

export function isSessionLocked(
    sessionId: string | undefined | null,
    characterId?: string | undefined | null,
    config?: PhoneAccessConfig,
): boolean {
    const scoped = config ?? loadPhoneAccessConfig();
    if (sessionId && scoped.lockedSessionIds.includes(sessionId)) return true;
    if (characterId && scoped.lockedCharacterIds.includes(characterId)) return true;
    return false;
}

export function setSessionLocked(sessionId: string, locked: boolean): PhoneAccessConfig {
    const config = loadPhoneAccessConfig();
    // 按角色上锁与按会话上锁统一走会话 ID：会话本身才是数据边界。
    const ids = new Set(config.lockedSessionIds);
    if (locked) ids.add(sessionId);
    else ids.delete(sessionId);
    const next: PhoneAccessConfig = { ...config, lockedSessionIds: Array.from(ids) };
    savePhoneAccessConfig(next);
    return next;
}

export function setCharacterLocked(characterId: string, locked: boolean): PhoneAccessConfig {
    const config = loadPhoneAccessConfig();
    const ids = new Set(config.lockedCharacterIds);
    if (locked) ids.add(characterId);
    else ids.delete(characterId);
    const next: PhoneAccessConfig = { ...config, lockedCharacterIds: Array.from(ids) };
    savePhoneAccessConfig(next);
    return next;
}

/** 当前会话是否允许被 AI 读取（总开关之外的第二道闸） */
export function canAiReadSession(
    sessionId: string | undefined | null,
    characterId?: string | undefined | null,
): boolean {
    const config = loadPhoneAccessConfig();
    if (!config.scopes.chat) return false;
    return !isSessionLocked(sessionId, characterId, config);
}

/** AI 是否能看某类数据（记忆、设置、朋友圈……） */
export function canAiReadScope(scope: PhoneAccessScopeId): boolean {
    return loadPhoneAccessConfig().scopes[scope];
}

/* ---------------- 动作权限判定 ---------------- */

export type PhoneAccessDecision =
    | { allowed: false; reason: "master_off" | "action_off" | "not_implemented" }
    | { allowed: true; mode: "delay" | "confirm"; delaySeconds: number };

export function resolvePhoneAccessDecision(
    actionId: PhoneAccessActionId,
    config?: PhoneAccessConfig,
): PhoneAccessDecision {
    const scoped = config ?? loadPhoneAccessConfig();
    const meta = getPhoneAccessActionMeta(actionId);
    if (!meta || !meta.implemented) return { allowed: false, reason: "not_implemented" };
    if (!scoped.masterEnabled) return { allowed: false, reason: "master_off" };
    const action = scoped.actions[actionId];
    if (!action?.enabled) return { allowed: false, reason: "action_off" };
    return { allowed: true, mode: action.mode, delaySeconds: action.delaySeconds };
}

/** 模型能看到的动作工具列表（总开关关闭时为空） */
export function getEnabledPhoneAccessActions(config?: PhoneAccessConfig): PhoneAccessActionMeta[] {
    const scoped = config ?? loadPhoneAccessConfig();
    if (!scoped.masterEnabled) return [];
    return PHONE_ACCESS_ACTIONS.filter(meta => meta.implemented && scoped.actions[meta.id]?.enabled);
}

/* ---------------- 撤销日志 ---------------- */

export type PhoneAccessLogEntry = {
    id: string;
    actionId: PhoneAccessActionId;
    characterId: string;
    characterName: string;
    /** 给人看的一句话描述 */
    summary: string;
    createdAt: string;
    /** 反向还原所需的数据 */
    revert: PhoneAccessRevertPayload;
    revertedAt?: string;
};

export type PhoneAccessRevertPayload =
    | { kind: "moment_like"; postId: string; likeId?: string }
    | { kind: "moment_comment"; postId: string; commentId: string }
    | { kind: "session_alias"; sessionId: string; previousAlias: string }
    | { kind: "session_pin"; sessionId: string; previousPinned: boolean }
    | { kind: "chat_message"; sessionId: string; messageId: string }
    | { kind: "contact_block"; characterId: string }
    | { kind: "moment_post"; postId: string }
    | { kind: "contact_alias"; characterId: string; previousAlias: string };

function generateLogId(): string {
    return `al_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function readRawLog(): PhoneAccessLogEntry[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(ACCESS_LOG_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed as PhoneAccessLogEntry[] : [];
    } catch {
        return [];
    }
}

function writeRawLog(entries: PhoneAccessLogEntry[]): void {
    if (typeof window === "undefined") return;
    kvSet(ACCESS_LOG_KEY, JSON.stringify(entries));
}

/** 按保留天数裁掉过期记录（0 = 永久保留） */
export function prunePhoneAccessLog(entries: PhoneAccessLogEntry[], retentionDays: number): PhoneAccessLogEntry[] {
    if (!retentionDays) return entries;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    return entries.filter(entry => {
        const time = Date.parse(entry.createdAt);
        if (!Number.isFinite(time)) return true;
        return time >= cutoff;
    });
}

export function logPhoneAccessAction(input: {
    actionId: PhoneAccessActionId;
    characterId: string;
    characterName: string;
    summary: string;
    revert: PhoneAccessRevertPayload;
}): PhoneAccessLogEntry {
    const config = loadPhoneAccessConfig();
    const entry: PhoneAccessLogEntry = {
        id: generateLogId(),
        actionId: input.actionId,
        characterId: input.characterId,
        characterName: input.characterName,
        summary: input.summary,
        createdAt: new Date().toISOString(),
        revert: input.revert,
    };
    const entries = prunePhoneAccessLog(readRawLog(), config.undoRetentionDays);
    entries.unshift(entry);
    writeRawLog(entries);
    return entry;
}

export function listPhoneAccessLog(): PhoneAccessLogEntry[] {
    const config = loadPhoneAccessConfig();
    const pruned = prunePhoneAccessLog(readRawLog(), config.undoRetentionDays);
    return pruned;
}

export function markPhoneAccessLogReverted(id: string): void {
    const entries = readRawLog();
    const target = entries.find(item => item.id === id);
    if (!target) return;
    target.revertedAt = new Date().toISOString();
    writeRawLog(entries);
}

export function removePhoneAccessLogEntry(id: string): void {
    const entries = readRawLog().filter(item => item.id !== id);
    writeRawLog(entries);
}

export function clearPhoneAccessLog(): void {
    writeRawLog([]);
}
