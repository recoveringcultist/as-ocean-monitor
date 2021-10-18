import express, { Request, Response } from "express";
import path from "path";
import { Telegraf } from "telegraf";
import { createBot } from "./bot";
const bodyParser = require("body-parser");

const PORT = Number(process.env.PORT) || 8080;

async function start() {
  const token = process.env.BOT_TOKEN;
  if (token === undefined) {
    throw new Error("BOT_TOKEN must be provided!");
  }

  // create bot
  const bot = await createBot();

  // create express server
  const app = express();
  app.use(bodyParser.json());
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/", (req: Request, res: Response) => res.send("Hello World!"));
  // Set the bot API endpoint
  const secretPath = `/telegraf/${bot.secretPathComponent()}`;
  app.use(bot.webhookCallback(secretPath));
  app.listen(PORT, () => {
    console.log(`as-ocean-monitor listening on port ${PORT}`);
  });

  // No need to call bot.launch()
}

start();
