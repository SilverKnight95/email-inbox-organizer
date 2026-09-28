export type MailMessage = {
  subject?: string;
  isRead?: boolean;
  flag?: { flagStatus?: string };
  from?: { emailAddress?: { address?: string } };
};

export type Rules = {
  never_move_unread?: boolean;
  skip_flagged?: boolean;
  global_exclude_subject?: string;
  auto_file?: Rule[];
};

type Rule = {
  match: string;
  value: string;
  folder: string;
  bypass_safety?: boolean;
  include_subject?: string;
};

export function chicagoSlot(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = get("weekday");
  const hour = Number(get("hour"));
  if (!["Mon", "Thu"].includes(weekday) || hour !== 8) {
    return null;
  }
  return `${get("year")}-${get("month")}-${get("day")}T08`;
}

export function classifyInbox(messages: MailMessage[], rules: Rules) {
  const summary = {
    inbox_scanned: 0,
    would_file: 0,
    left_unread: 0,
    left_flagged: 0,
    left_for_review: 0,
    filed: 0,
    by_folder: {} as Record<string, number>,
  };
  for (const message of messages) {
    summary.inbox_scanned += 1;
    const decision = classifyOne(message, rules);
    if (decision === "unread") {
      summary.left_unread += 1;
    } else if (decision === "flagged") {
      summary.left_flagged += 1;
    } else if (decision.startsWith("file:")) {
      summary.would_file += 1;
      const folder = decision.slice(5);
      summary.by_folder[folder] = (summary.by_folder[folder] ?? 0) + 1;
    } else {
      summary.left_for_review += 1;
    }
  }
  return summary;
}

function classifyOne(message: MailMessage, rules: Rules) {
  const subject = message.subject ?? "";
  const email = message.from?.emailAddress?.address?.toLowerCase() ?? "";
  const domain = email.includes("@") ? email.split("@")[1] : email;
  if (rules.never_move_unread !== false && message.isRead === false) {
    return "unread";
  }
  if (rules.skip_flagged !== false && message.flag?.flagStatus === "flagged") {
    return "flagged";
  }
  if (subject.toLowerCase().startsWith("inbox digest")) {
    return "review";
  }
  const safetyHold = rules.global_exclude_subject
    ? new RegExp(rules.global_exclude_subject, "i").test(subject)
    : false;
  for (const rule of rules.auto_file ?? []) {
    if (!matches(rule, email, domain, subject)) {
      continue;
    }
    if (rule.include_subject && !new RegExp(rule.include_subject, "i").test(subject)) {
      continue;
    }
    if (safetyHold && !rule.bypass_safety) {
      continue;
    }
    return `file:${rule.folder}`;
  }
  return "review";
}

function matches(rule: Rule, email: string, domain: string, subject: string) {
  const value = rule.value.toLowerCase();
  if (rule.match === "sender") {
    return email === value;
  }
  if (rule.match === "domain") {
    return domain === value;
  }
  if (rule.match === "domain_suffix") {
    return domain === value || domain.endsWith(`.${value}`);
  }
  if (rule.match === "subject") {
    return new RegExp(rule.value, "i").test(subject);
  }
  return false;
}
