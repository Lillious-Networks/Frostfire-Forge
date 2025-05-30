import log from "../modules/logger";
import nodemailer from "nodemailer";

// Email setup
const transporter = nodemailer.createTransport({
  pool: true,
  host: process.env.EMAIL_SERVICE,
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});

export default function sendEmail(email: string, subject: string, header: string, message: string): Promise<string> {
  return new Promise((resolve) => {

    if (!email || !subject || !message) {
      log.error("Email, subject, and message are required");
      resolve("Email, subject, and message are required");
      return;
    }

    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD || !process.env.EMAIL_SERVICE) {
      log.error("Email configuration is missing");
      resolve("Email configuration is missing");
      return;
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      log.error("Invalid email format");
      resolve("Invalid email format");
      return;
    }

    // Validate subject and message length
    if (subject.length > 78) {
      log.error("Subject exceeds maximum length of 78 characters");
      resolve("Subject exceeds maximum length of 78 characters");
      return;
    }

    if (message.length > 500) {
      log.error("Message exceeds maximum length of 500 characters");
      resolve("Message exceeds maximum length of 500 characters");
      return;
    }

    try {
      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: email,
        subject: `${header} - ${subject}`,
        html: createHTML(subject, message),
      };
      
      transporter.sendMail(mailOptions, function (error: any) {
        if (error) {
          log.error(error as string);
          resolve("Email failed to send");
        } else {
          log.info(`📧  Email Sent 📧
To: ${censorEmail(email)}
Subject: ${subject} 
Content Length: ${message.length}`);
          resolve("Email sent successfully");
        }
      });
    } catch (err) {
      log.error(err as string);
      resolve("Email system error");
    }
  });
}

const censorEmail = (email: string) => {
  const [local, domain] = email.split('@');
  
  const censoredLocal = local.length > 2
    ? `${local.slice(0, 2)}${'*'.repeat(local.length - 2)}`
    : '*'.repeat(local.length);
  
  const [domainName, domainExtension] = domain.split('.');
  
  const censoredDomain = `${domainName[0]}${'*'.repeat(domainName.length - 1)}.${domainExtension}`;
  
  return `${censoredLocal}@${censoredDomain}`;
};

function createHTML(subject: string, message: string) {
  return `<!doctypehtml><html lang=en xmlns:o=urn:schemas-microsoft-com:office:office xmlns:v=urn:schemas-microsoft-com:vml><title></title><meta content="text/html; charset=utf-8"http-equiv=Content-Type><meta content="width=device-width,initial-scale=1"name=viewport><!--[if mso]><xml><o:officedocumentsettings><o:pixelsperinch>96</o:pixelsperinch><o:allowpng></o:officedocumentsettings></xml><![endif]--><style>*{box-sizing:border-box}body{margin:0;padding:0}a[x-apple-data-detectors]{color:inherit!important;text-decoration:inherit!important}#MessageViewBody a{color:inherit;text-decoration:none}p{line-height:inherit}.desktop_hide,.desktop_hide table{mso-hide:all;display:none;max-height:0;overflow:hidden}.image_block img+div{display:none}@media (max-width:620px){.mobile_hide{display:none}.row-content{width:100%!important}.stack .column{width:100%;display:block}.mobile_hide{min-height:0;max-height:0;max-width:0;overflow:hidden;font-size:0}.desktop_hide,.desktop_hide table{display:table!important;max-height:none!important}}</style><body style=background-color:#e3e5e8;margin:0;padding:0;-webkit-text-size-adjust:none;text-size-adjust:none><table border=0 cellpadding=0 cellspacing=0 class=nl-container role=presentation style=mso-table-lspace:0;mso-table-rspace:0;background-color:#e3e5e8 width=100%><tr><td><table border=0 cellpadding=0 cellspacing=0 class="row row-1"role=presentation style=mso-table-lspace:0;mso-table-rspace:0;background-color:#e3e5e8 width=100% align=center><tr><td><table border=0 cellpadding=0 cellspacing=0 class="row-content stack"role=presentation style="mso-table-lspace:0;mso-table-rspace:0;color:#000;width:600px;margin:0 auto"width=600 align=center><tr><td class="column column-1"style=mso-table-lspace:0;mso-table-rspace:0;font-weight:400;text-align:left;padding-bottom:35px;padding-left:5px;padding-right:5px;padding-top:45px;vertical-align:top;border-top:0;border-right:0;border-bottom:0;border-left:0 width=100%><table border=0 cellpadding=0 cellspacing=0 class="block-1 empty_block"role=presentation style=mso-table-lspace:0;mso-table-rspace:0 width=100%><tr><td class=pad><div></div></table></table></table><table border=0 cellpadding=0 cellspacing=0 class="row row-2"role=presentation style=mso-table-lspace:0;mso-table-rspace:0;background-color:#e3e5e8 width=100% align=center><tr><td><table border=0 cellpadding=0 cellspacing=0 class="row-content stack"role=presentation style="mso-table-lspace:0;mso-table-rspace:0;background-color:#fff;color:#000;width:600px;margin:0 auto"width=600 align=center><tr><td class="column column-1"style=mso-table-lspace:0;mso-table-rspace:0;font-weight:400;text-align:left;padding-bottom:15px;padding-left:20px;padding-right:20px;padding-top:30px;vertical-align:top;border-top:0;border-right:0;border-bottom:0;border-left:0 width=100%><table border=0 cellpadding=15 cellspacing=0 class="block-1 text_block"role=presentation style=mso-table-lspace:0;mso-table-rspace:0;word-break:break-word width=100%><tr><td class=pad><div style=font-family:sans-serif><div style="font-size:12px;font-family:Arial,Helvetica Neue,Helvetica,sans-serif;mso-line-height-alt:14.399999999999999px;color:#393a3d;line-height:1.2"><p style=margin:0;font-size:14px;text-align:center;mso-line-height-alt:16.8px><span style=font-size:36px><strong>${subject}</strong></span></div></div></table></table></table><table border=0 cellpadding=0 cellspacing=0 class="row row-3"role=presentation style=mso-table-lspace:0;mso-table-rspace:0;background-color:#e3e5e8 width=100% align=center><tr><td><table border=0 cellpadding=0 cellspacing=0 class="row-content stack"role=presentation style="mso-table-lspace:0;mso-table-rspace:0;color:#000;width:600px;margin:0 auto"width=600 align=center><tr><td class="column column-1"style=mso-table-lspace:0;mso-table-rspace:0;font-weight:400;text-align:left;vertical-align:top;border-top:0;border-right:0;border-bottom:0;border-left:0 width=100%><table border=0 cellpadding=0 cellspacing=0 class="block-1 empty_block"role=presentation style=mso-table-lspace:0;mso-table-rspace:0 width=100%><tr><td class=pad><div></div></table></table></table><table border=0 cellpadding=0 cellspacing=0 class="row row-4"role=presentation style=mso-table-lspace:0;mso-table-rspace:0;background-color:#e3e5e8 width=100% align=center><tr><td><table border=0 cellpadding=0 cellspacing=0 class="row-content stack"role=presentation style="mso-table-lspace:0;mso-table-rspace:0;background-color:#fff;color:#000;width:600px;margin:0 auto"width=600 align=center><tr><td class="column column-1"style=mso-table-lspace:0;mso-table-rspace:0;font-weight:400;text-align:left;padding-bottom:5px;padding-left:30px;padding-right:30px;padding-top:5px;vertical-align:top;border-top:0;border-right:0;border-bottom:0;border-left:0 width=100%><table border=0 cellpadding=0 cellspacing=0 class="block-1 text_block"role=presentation style=mso-table-lspace:0;mso-table-rspace:0;word-break:break-word width=100%><tr><td class=pad style=padding-bottom:10px;padding-left:10px;padding-right:10px;padding-top:30px><div style=font-family:sans-serif><div style="text-align:center;font-size:12px;font-family:Arial,Helvetica Neue,Helvetica,sans-serif;mso-line-height-alt:14.399999999999999px;color:#393a3d;line-height:1.2"><p style=margin:0;font-size:14px;mso-line-height-alt:16.8px><span style=font-size:28px>${message}</span></div></div></table></table></table><table border=0 cellpadding=0 cellspacing=0 class="row row-5"role=presentation style=mso-table-lspace:0;mso-table-rspace:0;background-color:#e3e5e8 width=100% align=center><tr><td><table border=0 cellpadding=0 cellspacing=0 class="row-content stack"role=presentation style="mso-table-lspace:0;mso-table-rspace:0;color:#000;width:600px;margin:0 auto"width=600 align=center><tr><td class="column column-1"style=mso-table-lspace:0;mso-table-rspace:0;font-weight:400;text-align:left;vertical-align:top;border-top:0;border-right:0;border-bottom:0;border-left:0 width=100%><table border=0 cellpadding=0 cellspacing=0 class="block-1 empty_block"role=presentation style=mso-table-lspace:0;mso-table-rspace:0 width=100%><tr><td class=pad><div></div></table></table></table><table border=0 cellpadding=0 cellspacing=0 class="row row-6"role=presentation style=mso-table-lspace:0;mso-table-rspace:0;background-color:#e3e5e8 width=100% align=center><tr><td><table border=0 cellpadding=0 cellspacing=0 class="row-content stack"role=presentation style="mso-table-lspace:0;mso-table-rspace:0;color:#000;width:600px;margin:0 auto"width=600 align=center><tr><td class="column column-1"style=mso-table-lspace:0;mso-table-rspace:0;font-weight:400;text-align:left;vertical-align:top;border-top:0;border-right:0;border-bottom:0;border-left:0 width=100%><table border=0 cellpadding=0 cellspacing=0 class="block-1 empty_block"role=presentation style=mso-table-lspace:0;mso-table-rspace:0 width=100%><tr><td class=pad><div></div></table></table></table><table border=0 cellpadding=0 cellspacing=0 class="row row-7"role=presentation style=mso-table-lspace:0;mso-table-rspace:0 width=100% align=center><tr><td><table border=0 cellpadding=0 cellspacing=0 class="row-content stack"role=presentation style="mso-table-lspace:0;mso-table-rspace:0;background-color:#fff;color:#000;width:600px;margin:0 auto"width=600 align=center><tr><td class="column column-1"style=mso-table-lspace:0;mso-table-rspace:0;font-weight:400;text-align:left;padding-bottom:5px;padding-top:5px;vertical-align:top;border-top:0;border-right:0;border-bottom:0;border-left:0 width=100%><div style=height:20px;line-height:20px;font-size:1px class="block-1 spacer_block"></div></table></table><table border=0 cellpadding=0 cellspacing=0 class="row row-8"role=presentation style=mso-table-lspace:0;mso-table-rspace:0;background-color:#e3e5e8 width=100% align=center><tr><td><table border=0 cellpadding=0 cellspacing=0 class="row-content stack"role=presentation style="mso-table-lspace:0;mso-table-rspace:0;background-color:#fff;color:#000;width:600px;margin:0 auto"width=600 align=center><tr><td class="column column-1"style=mso-table-lspace:0;mso-table-rspace:0;font-weight:400;text-align:left;padding-bottom:5px;padding-top:5px;vertical-align:top;border-top:0;border-right:0;border-bottom:0;border-left:0 width=100%><table border=0 cellpadding=10 cellspacing=0 class="block-1 text_block"role=presentation style=mso-table-lspace:0;mso-table-rspace:0;word-break:break-word width=100%><tr><td class=pad><div style=font-family:sans-serif><div style="font-size:12px;font-family:Arial,Helvetica Neue,Helvetica,sans-serif;mso-line-height-alt:14.399999999999999px;color:#555;line-height:1.2"><p style=margin:0;font-size:12px;mso-line-height-alt:14.399999999999999px><br></div></div></table></table></table></table><div style=background-color:transparent><div style="Margin:0 auto;min-width:320px;max-width:500px;overflow-wrap:break-word;word-wrap:break-word;word-break:break-word;background-color:transparent"class=block-grid><div style=border-collapse:collapse;display:table;width:100%;background-color:transparent><!--[if (mso)|(IE)]><table border=0 cellpadding=0 cellspacing=0 width=100%><tr><td style=background-color:transparent align=center><table border=0 cellpadding=0 cellspacing=0 style=width:500px><tr class=layout-full-width style=background-color:transparent><![endif]--><!--[if (mso)|(IE)]><td align=center width=500 style="width:500px;padding-right:0;padding-left:0;padding-top:15px;padding-bottom:15px;border-top:0 solid transparent;border-left:0 solid transparent;border-bottom:0 solid transparent;border-right:0 solid transparent"valign=top><![endif]--><div style=min-width:320px;max-width:500px;display:table-cell;vertical-align:top class="col num12"><div style=background-color:transparent;width:100%!important><!--[if (!mso)&(!IE)]><!--><div style="border-top:0 solid transparent;border-left:0 solid transparent;border-bottom:0 solid transparent;border-right:0 solid transparent;padding-top:15px;padding-bottom:15px;padding-right:0;padding-left:0"><!--<![endif]--><div style=padding-right:0;padding-left:0 class="autowidth center img-container"align=center><!--[if mso]><table border=0 cellpadding=0 cellspacing=0 width=100%><tr><td style=padding-right:0;padding-left:0 align=center><![endif]--><!--[if mso]><![endif]--></div><!--[if (!mso)&(!IE)]><!--></div><!--<![endif]--></div></div><!--[if (mso)|(IE)]><![endif]--></div></div></div>`;
}
