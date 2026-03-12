
import { Telegraf } from 'telegraf';
import 'dotenv/config';

async function testBot() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        console.error("No token");
        return;
    }
    const bot = new Telegraf(token);
    try {
        const me = await bot.telegram.getMe();
        console.log("Bot validated:", me.username);
    } catch (e: any) {
        console.error("Bot validation failed:", e.message);
    }
}

testBot();
