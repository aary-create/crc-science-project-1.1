import { NextResponse } from "next/server";
import { actionFor, alertsNear, currentAlert, fetchLiveAlerts } from "@/lib/data";
import { makeT, type Key } from "@/lib/i18n";
import { appUrl, configuredChannels, sendMessage } from "@/lib/outbound";
import { SEVERITY_RANK } from "@/lib/severity";
import { activeSubscriptions, markSent, type Subscription } from "@/lib/subscriptions";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Sends SMS / WhatsApp / email to confirmed subscribers when the alert at
// their spot changes. Called by a scheduler every few minutes with
//   Authorization: Bearer <CRON_SECRET>
// (see .github/workflows/dispatch-alerts.yml — Vercel's own cron on the free
// plan only runs once a day, which is too slow for alerts).

const MAX_SENDS_PER_RUN = 100;

async function run(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "Set CRON_SECRET to enable dispatch." }, { status: 501 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  const channels = configuredChannels();
  const subs = (await activeSubscriptions()).filter((s) => channels.includes(s.channel));
  if (!subs.length) return NextResponse.json({ checked: 0, sent: 0 });

  const { sachetOk, imdOk, alerts } = await fetchLiveAlerts();
  // Never send "all clear" (or anything) based on feeds we couldn't read.
  if (!sachetOk && !imdOk) return NextResponse.json({ checked: subs.length, sent: 0, skipped: "both alert feeds unreachable" });

  const base = appUrl(new URL(req.url).origin);
  const jobs: { s: Subscription; key: string | null; subject: string; text: string }[] = [];

  for (const s of subs) {
    const c = currentAlert(alertsNear(alerts, s.lat, s.lng, s.district, s.state));
    const t = makeT(s.language);
    const stop = `${base}/api/subscribe?unsubscribe=${s.token}`;
    if (c) {
      if (SEVERITY_RANK[c.alert.severity] < SEVERITY_RANK[s.min_severity]) continue;
      // Time-of-day aware: a non-extreme heat advisory isn't pushed overnight;
      // it goes out in the morning if it's still in effect.
      if (c.deprioritised === "night_heat") continue;
      const key = `${c.alert.id}|${c.alert.severity}`;
      if (key === s.last_alert_key) continue;
      const { action } = actionFor(s, c.alert.hazard_type);
      const title = `${t(`s_${c.alert.severity}` as Key)} ${t(`h_${c.alert.hazard_type}` as Key)}`;
      const agencies = [...new Set(c.sources.map((x) => x.agency))].join(", ");
      jobs.push({
        s, key,
        subject: `Suraksha Setu: ${title} — ${s.label.slice(0, 60)}`,
        text: `Suraksha Setu: ${title} (${agencies}) for ${s.label.slice(0, 60)}. ${c.alert.headline}. ${t("whatToDo")}: ${action} ${base}/dashboard  Stop: ${stop}`,
      });
    } else if (s.last_alert_key) {
      jobs.push({
        s, key: null,
        subject: `Suraksha Setu: ${t("noAlert")} — ${s.label.slice(0, 60)}`,
        text: `Suraksha Setu: ${t("noAlert")} for ${s.label.slice(0, 60)} (${t("noAlertSub")}) Stop: ${stop}`,
      });
    }
  }

  let sent = 0, failed = 0;
  const batch = jobs.slice(0, MAX_SENDS_PER_RUN);
  for (let i = 0; i < batch.length; i += 10) {
    await Promise.all(batch.slice(i, i + 10).map(async (j) => {
      try {
        await sendMessage(j.s.channel, j.s.address, j.subject, j.text);
        await markSent(j.s.id, j.key);
        sent++;
      } catch (err) {
        failed++;
        console.error(`[dispatch] ${j.s.channel} to subscription ${j.s.id} failed:`, err);
      }
    }));
  }
  return NextResponse.json({ checked: subs.length, sent, failed, deferred: Math.max(0, jobs.length - batch.length) });
}

export const GET = run;
export const POST = run;
