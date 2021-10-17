import * as functions from "firebase-functions";
import { Context, Markup, Telegraf } from "telegraf";
import { getOceans } from "./oceans";

export async function createBot() {
  const { FUNCTION_NAME, PROJECT_ID, REGION } = process.env;

  const BOT_TOKEN = functions.config().telegram.token;
  if (BOT_TOKEN === undefined) {
    throw new TypeError("BOT_TOKEN must be provided!");
  }
  const bot = new Telegraf(BOT_TOKEN);

  // remove old webhook
  let result = await bot.telegram.setWebhook("");
  console.log(`result of canceling webhook: ${result}`);

  result = await bot.telegram.setWebhook(
    `https://${REGION!}-${PROJECT_ID!}.cloudfunctions.net/${FUNCTION_NAME!}`
  );
  console.log(`result of setting up webhook: ${result}`);

  bot.start((ctx) => ctx.reply("Welcome"));
  bot.help((ctx) => ctx.reply("help text goes here"));
  bot.command("hello", (ctx) => ctx.reply("Hello, friend!"));
  bot.command("oceans", commandOceans);
  bot.hears(/\/ocean (\d+)/, oceanInfo);
  bot.hears("hi", (ctx) => ctx.reply("Hey there"));
  bot.launch();

  // Enable graceful stop
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  return bot;
}

const commandOceans = async (ctx: Context) => {
  const oceans = await getOceans();
  // {"name":"JAWS","depositToken":"JAWS","earningToken":"GUARD","address":"0xF50d7a5066D74c67361176bEddfA0A5379a5d429","depositTokenAddress":"0xdD97AB35e3C0820215bc85a395e13671d84CCBa2","earningTokenAddress":"0xF606bd19b1E61574ED625d9ea96C841D4E247A32","active":true}

  let numOceans = oceans.length;

  const buttons: any[] = [];
  for (let i = 0; i < oceans.length; i++) {
    buttons.push(`/ocean ${i}`);
  }

  return ctx.reply(
    `there are ${numOceans} oceans, which do you want info on?`,
    Markup.keyboard(buttons, { columns: 4 }).oneTime().resize()
  );
};

const oceanInfo = async (ctx) => {
  const oceans = await getOceans();

  const which = parseInt(ctx.match[1]);
  if (which >= oceans.length) {
    return ctx.reply("invalid ocean id");
  }

  return ctx.reply(JSON.stringify(oceans[which]));
};
