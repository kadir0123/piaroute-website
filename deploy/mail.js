const nodemailer = require("nodemailer");

const SUBJECT = "Piaroute gelişmelerine kaydın alındı";
const TEXT = [
  "Merhaba,",
  "",
  "Piaroute hakkındaki gelişmeleri bu adrese yazacağız.",
  "",
  "Listeden çıkmak için bu adrese yanıt yazman yeterli.",
  "",
  "Piaroute",
].join("\n");

function transport() {
  return nodemailer.createTransport({
    host: "127.0.0.1",
    port: 25,
    secure: false,
    tls: { rejectUnauthorized: false },
  });
}

async function sendWelcome(to) {
  await transport().sendMail({
    from: process.env.MAIL_FROM || "Piaroute <kadir@piaroute.com>",
    to,
    subject: SUBJECT,
    text: TEXT,
  });
  return true;
}

module.exports = { sendWelcome, sendPasswordReset };

async function sendPasswordReset(to, link) {
  const text = [
    "Merhaba,",
    "",
    "Piaroute şifreni yenilemek için bu bağlantıyı aç:",
    link,
    "",
    "Bağlantı 30 dakika geçerlidir. Bu isteği sen yapmadıysan bu postayı yok say.",
    "",
    "Piaroute",
  ].join("\n");
  await transport().sendMail({
    from: process.env.MAIL_FROM || "Piaroute <kadir@piaroute.com>",
    to,
    subject: "Piaroute şifre yenileme",
    text,
  });
  return true;
}
