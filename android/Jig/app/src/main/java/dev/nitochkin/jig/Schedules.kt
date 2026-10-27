package dev.nitochkin.jig

import android.app.*
import android.content.*
import android.net.Uri
import android.os.Build
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject

/** Persisted, app-scoped schedules; the OS delivers these without a JS runtime. */
object Schedules {
    private const val PREFS = "jig.schedules"
    fun set(context: Context, args: JSONObject, done: (String) -> Unit) {
        val app = args.optString("app")
        val items = args.optJSONArray("items") ?: JSONArray()
        if (app.isEmpty()) return done(Services.error("Invalid app"))
        val manager = context.getSystemService(AlarmManager::class.java)
        val proceed = {
            try {
                if ((0 until items.length()).any { items.getJSONObject(it).optBoolean("alarm") } && Build.VERSION.SDK_INT >= 31 && !manager.canScheduleExactAlarms()) {
                    done(Services.error("Enable Alarms & reminders for Jig in Android Settings, then reopen this app."))
                } else {
                    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    val old = JSONArray(prefs.getString(app, "[]"))
                    for (i in 0 until old.length()) manager.cancel(delivery(context, old.getJSONObject(i)))
                    prefs.edit().putString(app, items.toString()).apply()
                    for (i in 0 until items.length()) schedule(context, items.getJSONObject(i))
                    done(Services.result(JSONObject()))
                }
            } catch (e: Exception) { done(Services.error(e.message ?: "Scheduling failed")) }
        }
        if (items.length() > 0 && Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            val request = Services.requestPermission ?: return done(Services.error("Open Jig to enable notifications"))
            request(android.Manifest.permission.POST_NOTIFICATIONS) { allowed -> if (allowed) proceed() else done(Services.error("Notifications denied")) }
        } else proceed()
    }
    private fun key(item: JSONObject) = "${item.optString("app")}/${item.optString("id")}" 
    private fun delivery(context: Context, item: JSONObject): PendingIntent = PendingIntent.getBroadcast(context, 0,
        Intent(context, ScheduleReceiver::class.java).setAction("dev.nitochkin.jig.DELIVER")
            .setData(Uri.parse("jig-alarm:" + Uri.encode(key(item))))
            .putExtra("item", item.toString()), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    fun openIntent(context: Context, item: JSONObject): PendingIntent = PendingIntent.getActivity(context, 0,
        Intent(context, MainActivity::class.java).setData(Uri.parse("jig-open:" + Uri.encode(key(item))))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra("jigApp", item.optString("app")).putExtra("jigScreen", item.optString("open")),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    private fun schedule(context: Context, item: JSONObject) {
        val at = item.optLong("at")
        if (at <= System.currentTimeMillis()) return
        val manager = context.getSystemService(AlarmManager::class.java)
        if (item.optBoolean("alarm")) manager.setAlarmClock(AlarmManager.AlarmClockInfo(at, openIntent(context, item)), delivery(context, item))
        else manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, delivery(context, item))
    }
    fun restore(context: Context) {
        for (value in context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).all.values) {
            runCatching {
                val items = JSONArray(value as String)
                for (i in 0 until items.length()) schedule(context, items.getJSONObject(i))
            }
        }
    }
    fun deliver(context: Context, item: JSONObject) {
        val alarm = item.optBoolean("alarm")
        val channel = if (alarm) "jig.alarms" else "jig.reminders"
        val manager = context.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            val ch = NotificationChannel(channel, if (alarm) "Alarms" else "Reminders", NotificationManager.IMPORTANCE_HIGH)
            ch.setSound(if (alarm) Settings.System.DEFAULT_ALARM_ALERT_URI else Settings.System.DEFAULT_NOTIFICATION_URI,
                android.media.AudioAttributes.Builder().setUsage(if (alarm) android.media.AudioAttributes.USAGE_ALARM else android.media.AudioAttributes.USAGE_NOTIFICATION).build())
            manager.createNotificationChannel(ch)
        }
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, channel) else Notification.Builder(context)
        builder.setSmallIcon(android.R.drawable.ic_lock_idle_alarm).setContentTitle(item.optString("title", "Jig"))
            .setContentText(item.optString("body")).setContentIntent(openIntent(context, item)).setAutoCancel(true)
            .setCategory(if (alarm) Notification.CATEGORY_ALARM else Notification.CATEGORY_REMINDER)
        if (alarm) builder.setFullScreenIntent(openIntent(context, item), true)
        if (Build.VERSION.SDK_INT < 26) builder.setSound(if (alarm) Settings.System.DEFAULT_ALARM_ALERT_URI else Settings.System.DEFAULT_NOTIFICATION_URI)
        manager.notify(key(item), 0, builder.build())
    }
}
class ScheduleReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == "dev.nitochkin.jig.DELIVER") {
            runCatching { Schedules.deliver(context, JSONObject(intent.getStringExtra("item") ?: return)) }
        } else Schedules.restore(context)
    }
}
