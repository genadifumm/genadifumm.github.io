<div dir="rtl">

# עוזר אישי בוואטסאפ (Claude)

עוזר שאתה כותב לו בוואטסאפ, והוא עונה.
הוא גם שולח לך הודעות בעצמו: תזכורות והודעת בוקר.

רק דרכים רשמיות:
- **WhatsApp Cloud API** של Meta.
- **Claude API** של Anthropic.
- שרת קטן ב-Python שרץ אצלך בענן.

## מה הוא יודע לעשות
- שיחה רגילה, בעברית.
- "תזכיר לי מחר ב-9 להתקשר לרופא" → שולח לך הודעה בזמן.
- "מה התזכורות שלי?" / "בטל תזכורת 3".
- חיפוש ברשת לשאלות עדכניות.
- הודעת בוקר יומית (אפשר לכבות).
- `/איפוס` מנקה את זיכרון השיחה.
- עונה רק למספר שלך. כל מספר אחר נחסם.

## מה צריך
1. מפתח API של Anthropic: console.anthropic.com.
2. חשבון Meta for Developers: developers.facebook.com.
3. מספר טלפון נוסף לבוט (לא המספר הפרטי שלך).
4. שרת עם כתובת https. למשל Railway, Render, Fly.io או VPS.

## הקמה, שלב אחר שלב

### 1. Meta
1. ב-developers.facebook.com: צור App מסוג **Business**.
2. הוסף את המוצר **WhatsApp**.
3. ב-WhatsApp → API Setup: הוסף את מספר הבוט ואמת אותו.
4. העתק את **Phone number ID** → `WA_PHONE_NUMBER_ID`.
5. ב-App settings → Basic: העתק **App secret** → `WA_APP_SECRET`.
6. ב-Business Settings → System users: צור משתמש, תן לו הרשאות `whatsapp_business_messaging` ו-`whatsapp_business_management`, וצור טוקן קבוע → `WA_TOKEN`.

### 2. תבנית הודעה (לתזכורות)
וואטסאפ מרשה לבוט לכתוב חופשי רק עד 24 שעות מההודעה האחרונה שלך.
אחרי זה חייבים תבנית מאושרת.
1. ב-WhatsApp Manager → Message templates → Create.
2. שם: `assistant_notification`, שפה: Hebrew, קטגוריה: Utility.
3. גוף ההודעה: `{{1}}`
4. חכה לאישור (בדרך כלל דקות).

### 3. העלאה לשרת
1. העתק את `.env.example` ל-`.env` ומלא את הערכים.
2. `OWNER_PHONE` = המספר שלך, ספרות בלבד, עם 972. למשל `972521234567`.
3. הרץ עם Docker:
```
docker build -t wa-assistant .
docker run -d --env-file .env -v wa-data:/data -p 8000:8000 wa-assistant
```
4. ודא ש-`https://הכתובת-שלך/health` מחזיר `{"ok":true}`.

### 4. חיבור ה-Webhook
1. ב-WhatsApp → Configuration → Webhook.
2. Callback URL: `https://הכתובת-שלך/webhook`
3. Verify token: אותו ערך כמו `WA_VERIFY_TOKEN`.
4. Subscribe לשדה **messages**.

### 5. בדיקה
שלח לבוט "היי" מהמספר שלך.

## הגדרות שימושיות
| משתנה | מה עושה |
|---|---|
| `CLAUDE_EFFORT` | `low` = מהיר וזול. `high` = יסודי יותר. |
| `DAILY_BRIEF_HOUR` | שעת הודעת בוקר. ריק = כבוי. |
| `TIMEZONE` | ברירת מחדל `Asia/Jerusalem`. |
| `HISTORY_LIMIT` | כמה הודעות אחרונות הוא זוכר. |

## עלויות
- Claude: לפי שימוש.
- וואטסאפ: הודעות בתוך חלון 24 שעות חינם. הודעות תבנית בתשלום קטן.
- שרת: לרוב כמה דולרים בחודש.

## קבצים
- `app.py` — השרת, ה-Webhook ותזמון ההודעות.
- `assistant.py` — החיבור ל-Claude והכלים (תזכורות).
- `whatsapp.py` — שליחת הודעות דרך ה-API הרשמי.
- `storage.py` — מסד נתונים SQLite.
- `config.py` — הגדרות ממשתני סביבה.

</div>
