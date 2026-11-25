<div dir="rtl">

# עוזר אישי בוואטסאפ (Claude)

אתה כותב לו בוואטסאפ, והוא עונה.
הוא גם שולח לך הודעות בעצמו: תזכורות והודעת בוקר.

רק שירותים רשמיים:
- **WhatsApp Cloud API** של Meta.
- **Claude API** של Anthropic, עם המודל החסכוני Haiku.
- **Cloudflare Workers**, שרת חינמי.

## מה הוא יודע לעשות
- שיחה רגילה בעברית.
- "תזכיר לי מחר ב-9 להתקשר לרופא".
- "מה התזכורות שלי?" או "בטל תזכורת 3".
- חיפוש ברשת לשאלות עדכניות.
- הודעת בוקר ב-8:00.
- `/איפוס` מנקה את זיכרון השיחה.
- עונה רק למספר שלך.

## עלות משוערת
- שרת: **חינם**.
- Claude: פחות מ-$1 לחודש בשימוש רגיל.
- וואטסאפ: חינם בתוך 24 שעות מההודעה האחרונה שלך. אחרי זה, אגורות להודעה.

## הקמה (אפשר מהטלפון)

### 1. Anthropic
1. ב-platform.claude.com פותחים חשבון וטוענים $5.
2. ב-API Keys יוצרים מפתח ושומרים אותו.

### 2. Meta
1. ב-developers.facebook.com יוצרים App ומוסיפים WhatsApp.
2. ב-API Setup שומרים את **Phone number ID**.
3. מוסיפים את המספר שלך כנמען.
4. ב-App settings → Basic שומרים את **App secret**.
5. יוצרים טוקן קבוע דרך System user.
6. יוצרים תבנית בשם `assistant_notification` בעברית, קטגוריה Utility, וגוף `{{1}}`.

### 3. Cloudflare
1. ב-dash.cloudflare.com פותחים חשבון חינמי.
2. נכנסים ל-Workers & Pages → Create → Import a repository.
3. בוחרים את הריפו הזה, ומגדירים Root directory: `whatsapp-assistant`.
4. ב-Settings → Variables and Secrets מוסיפים את הסודות הבאים:

| שם | ערך |
|---|---|
| `ANTHROPIC_API_KEY` | המפתח מ-Anthropic |
| `WA_TOKEN` | הטוקן מ-Meta |
| `WA_PHONE_NUMBER_ID` | ה-Phone number ID |
| `WA_APP_SECRET` | ה-App secret |
| `WA_VERIFY_TOKEN` | מילה סודית שתבחר |
| `OWNER_PHONE` | המספר שלך, למשל `972521234567` |

### 4. חיבור
1. ב-Meta → WhatsApp → Configuration מגדירים Callback URL:
   `https://whatsapp-assistant.<שם-החשבון>.workers.dev/webhook`
2. Verify token: אותה מילה כמו `WA_VERIFY_TOKEN`.
3. עושים Subscribe לשדה **messages**.

### 5. בדיקה
שולחים לבוט "היי".

## הגדרות (בקובץ wrangler.toml)
- `CLAUDE_MODEL`: המודל. ברירת המחדל: `claude-haiku-5-5`.
- `DAILY_BRIEF_HOUR`: שעת הודעת הבוקר. ריק = כבוי.
- `TIMEZONE`: אזור הזמן.

</div>
