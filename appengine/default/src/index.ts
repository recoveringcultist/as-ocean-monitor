import express, { Request, Response } from "express";
import path from "path";
import { Telegraf } from "telegraf";
import { createBot } from "./bot";
import * as admin from "firebase-admin";

const bodyParser = require("body-parser");
const serviceAccount = require("../cert/as-ocean-monitor-firebase-adminsdk-2ixa8-f97864a91b.json");

const PORT = Number(process.env.PORT) || 8080;

async function start() {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://as-ocean-monitor-default-rtdb.firebaseio.com",
  });

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
  app.get("/_ah/start", (req, res) => {
    res.send("starting");
  });
  app.get("/_ah/stop", (req, res) => {
    try {
      bot.stop("/_ah/stop");
    } catch (e) {}
    res.send("stopped");
  });
  app.listen(PORT, () => {
    console.log(`as-ocean-monitor listening on port ${PORT}`);
  });

  // No need to call bot.launch()
}

start();
