// Training mode: short budgeting lessons in Finnish and English.
// Pure data + checks (no DOM), so the checks can be tested in Node.
//
// The core ideas come from a finance advisor's teaching:
//  1. With a budget you know in advance whether problems are coming.
//  2. It increases your sense of control over your life.
//  3. Through the budget, money becomes a resource.

import * as core from './core.js';

export const UI = {
  en: {
    intro: 'A budget is a plan for your money. These short lessons show how to make one with this app, and why it’s worth it. Each takes a minute or two.',
    progress: (n, t) => `${n} of ${t} done`,
    tryIt: 'Try it →',
    next: 'Next lesson',
    markDone: 'Mark as done',
    undo: 'Mark as not done',
    detected: 'Done: detected from your budget',
    done: 'Done',
    tip: 'Tip',
    banner: 'New to budgeting? Learn how in 8 short steps.',
    start: 'Start',
    notNow: 'Not now',
    back: '← Back to lesson',
    disclaimer: 'General guidance, not personal financial advice.',
  },
  fi: {
    intro: 'Budjetti on suunnitelma rahoillesi. Näissä lyhyissä oppitunneissa näet, miten sellainen tehdään tällä sovelluksella ja miksi se kannattaa. Kukin vie minuutin tai kaksi.',
    progress: (n, t) => `${n}/${t} tehty`,
    tryIt: 'Kokeile →',
    next: 'Seuraava oppitunti',
    markDone: 'Merkitse tehdyksi',
    undo: 'Poista merkintä',
    detected: 'Tehty: tunnistettu budjetistasi',
    done: 'Tehty',
    tip: 'Vinkki',
    banner: 'Uusi budjetoinnissa? Opi se 8 lyhyessä vaiheessa.',
    start: 'Aloita',
    notNow: 'Ei nyt',
    back: '← Takaisin oppituntiin',
    disclaimer: 'Yleistä ohjausta, ei henkilökohtaista talousneuvontaa.',
  },
};

// ---------- checks: does the budget already show this step is done? ----------

const plannedSum = (b, y, cat) => (b.plans[y]?.[cat] || []).reduce((a, x) => a + x, 0);
const SAVINGS_RE = /sav|buffer|emergency|rainy|säästö|puskuri|vararah|sukanvar/i;

const checks = {
  income: (b, y) => b.categories.some(c => c.type === 'income' && plannedSum(b, y, c.name) > 0),
  fixed: (b, y) => b.categories.some(c => c.type === 'expense' && c.certain && plannedSum(b, y, c.name) > 0),
  everyday: (b, y) => b.categories.filter(c => c.type === 'expense' && !c.certain && plannedSum(b, y, c.name) > 0).length >= 2,
  savings: (b, y) => b.categories.some(c => c.type === 'expense' && SAVINGS_RE.test(c.name) && plannedSum(b, y, c.name) > 0),
  ahead: (b, y) => core.yearStats(b, y).every(s => s.income.planned > 0 && s.expense.planned > 0),
  track: (b, y, m) => b.tx.filter(t => t.date.startsWith(core.ym(y, m))).length >= 3,
};

// Returns true when the budget shows the lesson's step is done, null if it can't be detected.
export function detect(lesson, budget, now = new Date()) {
  const f = checks[lesson.id];
  return f ? f(budget, String(now.getFullYear()), now.getMonth()) : null;
}

// ---------- lessons ----------
// `action` tells the app where "Try it" goes. Body text is trusted static HTML.
// {key} placeholders are replaced with the current translation of that i18n.js key,
// so lessons always name buttons and views exactly as the UI shows them.

export const LESSONS = [
  {
    id: 'why',
    en: {
      title: 'Why make a budget?',
      body: `
        <p>With a budget you <b>know in advance whether problems are coming</b>. If you can see in October
        that December won’t add up, you still have time to do something about it. Without a budget you
        find out at the checkout or from an overdue bill.</p>
        <p>A budget <b>gives you more control over your life</b>. Money stops being something that just happens
        to you. You decide where it goes, and you can see your decisions working.</p>
        <p>Over time, <b>money becomes a resource</b> instead of a worry: something you can use for the things that
        matter to you.</p>
        <p>Budgeting doesn’t mean living on as little as possible. It means knowing.</p>`,
      tip: 'You don’t need to get it perfect. A rough plan you actually use beats a perfect one you don’t.',
    },
    fi: {
      title: 'Miksi budjetti?',
      body: `
        <p>Budjetin avulla <b>tiedät etukäteen, onko tulossa ongelmia</b>. Jos näet jo lokakuussa, ettei
        joulukuu mene plussalle, ehdit vielä tehdä asialle jotain. Ilman budjettia sen huomaa vasta kaupan
        kassalla tai erääntyneestä laskusta.</p>
        <p>Budjetti <b>lisää elämänhallintaa</b>. Raha ei ole enää jotain, mikä vain tapahtuu sinulle. Sinä päätät,
        mihin se menee, ja näet, että päätöksesi toimivat.</p>
        <p>Ajan myötä <b>rahasta tulee voimavara</b> eikä huolenaihe: jotain, mitä voit käyttää sinulle tärkeisiin
        asioihin.</p>
        <p>Budjetointi ei tarkoita mahdollisimman niukkaa elämää. Se tarkoittaa, että tiedät.</p>`,
      tip: 'Täydellisyyttä ei tarvita. Karkea suunnitelma, jota oikeasti käytät, on parempi kuin täydellinen, jota et käytä.',
    },
  },
  {
    id: 'income',
    action: { tab: 'year' },
    en: {
      title: 'Start with your income',
      body: `
        <p>Write down everything that comes in during a month: salary, benefits, pension, student grant,
        regular side income. Use the amount that actually lands in your account, after taxes.</p>
        <p>Income you can count on, such as salary or a regular benefit, is <b>certain income</b>. In
        <b>{tab.cats}</b>, set its type to <i>{type.incomeCertain}</i>. The app then counts it automatically every
        month, even before the money has arrived.</p>
        <p>If your income varies, plan with a cautious estimate. A pleasant surprise is better than an
        unpleasant one.</p>`,
      tip: 'Open {tab.year} and enter your income for each month. ⇉ copies a value to all months.',
    },
    fi: {
      title: 'Aloita tuloista',
      body: `
        <p>Kirjaa kaikki, mitä kuukaudessa tulee: palkka, etuudet, eläke, opintoraha, säännölliset sivutulot.
        Käytä summaa, joka oikeasti tulee tilille verojen jälkeen.</p>
        <p>Tulot, joihin voit luottaa, kuten palkka tai säännöllinen etuus, ovat <b>varmoja tuloja</b>. Valitse
        <b>{tab.cats}</b>-välilehdellä luokan tyypiksi <i>{type.incomeCertain}</i>. Silloin sovellus
        laskee sen automaattisesti joka kuukausi, jo ennen kuin raha on tullut tilille.</p>
        <p>Jos tulosi vaihtelevat, suunnittele varovaisen arvion mukaan. Iloinen yllätys on parempi kuin ikävä.</p>`,
      tip: 'Avaa {tab.year} ja kirjaa tulosi jokaiselle kuukaudelle. ⇉ kopioi summan kaikille kuukausille.',
    },
  },
  {
    id: 'fixed',
    action: { tab: 'cats' },
    en: {
      title: 'Fixed costs come first',
      body: `
        <p>Fixed costs are bills that come whether you like it or not: rent, electricity, phone and internet,
        insurance, loan payments, daycare.</p>
        <p>Set their type to <i>{type.expenseCertain}</i>. The budget then assumes they will be paid, because they will be.</p>
        <p>Watch out for bills that don’t come every month: quarterly insurance, a yearly subscription, a car
        inspection. Plan them in the <b>month they are actually due</b>. Then the plan warns you about the
        expensive months before they arrive.</p>`,
      tip: 'Go through last year’s bank statements or e-invoices. These bills are easy to forget.',
    },
    fi: {
      title: 'Kiinteät menot ensin',
      body: `
        <p>Kiinteät menot ovat laskuja, jotka tulevat halusit tai et: vuokra, sähkö, puhelin ja netti,
        vakuutukset, lainanlyhennykset, päivähoito.</p>
        <p>Valitse niiden tyypiksi <i>{type.expenseCertain}</i>. Silloin budjetti olettaa, että ne
        maksetaan, kuten ne maksetaankin.</p>
        <p>Muista laskut, jotka eivät tule joka kuukausi: neljännesvuosittain maksettava vakuutus, vuosimaksu,
        auton katsastus. Kirjaa ne siihen <b>kuukauteen, jolloin ne oikeasti erääntyvät</b>. Silloin
        suunnitelma varoittaa kalliista kuukausista ennen kuin ne tulevat.</p>`,
      tip: 'Käy läpi viime vuoden tiliotteet tai e-laskut. Nämä laskut unohtuvat helposti.',
    },
  },
  {
    id: 'everyday',
    action: { tab: 'year' },
    en: {
      title: 'Estimate everyday spending',
      body: `
        <p>Food, transport, toiletries, hobbies, eating out. These vary, so they’re harder to guess.</p>
        <p>The easiest way: track your spending for a month or two, then plan from what you actually spent.
        Your first estimates will be off. That’s normal and part of learning.</p>
        <p>Separate categories show you where your money goes. Don’t make too many, though: 8–12 categories is
        plenty for most people.</p>`,
    },
    fi: {
      title: 'Arvioi arjen menot',
      body: `
        <p>Ruoka, liikkuminen, hygienia, harrastukset, ulkona syöminen. Nämä vaihtelevat, joten niitä on
        vaikeampi arvata.</p>
        <p>Helpoin tapa: seuraa menojasi kuukausi tai kaksi ja suunnittele sen mukaan, mitä oikeasti kului.
        Ensimmäiset arviot menevät pieleen. Se on normaalia ja kuuluu oppimiseen.</p>
        <p>Erilliset luokat näyttävät, mihin rahasi menevät. Liikaa niitä ei kannata tehdä: useimmille
        8–12 luokkaa riittää hyvin.</p>`,
    },
  },
  {
    id: 'savings',
    action: { tab: 'cats' },
    en: {
      title: 'Pay yourself first',
      body: `
        <p>Plan savings as an expense, with a category such as <i>Savings</i> or <i>Buffer</i>, instead of hoping
        something is left at the end of the month. Usually nothing is.</p>
        <p>Start with a buffer for surprises: a broken phone, a dentist visit, a washing machine. Even a small
        amount each month helps. The habit matters more than the amount.</p>
        <p>Once you have a buffer, a surprise is just an expense, not a crisis.</p>`,
    },
    fi: {
      title: 'Maksa ensin itsellesi',
      body: `
        <p>Suunnittele säästäminen menona, esimerkiksi luokkana <i>Säästöt</i> tai <i>Puskuri</i>, sen sijaan että
        toivoisit jotain jäävän kuun lopussa. Yleensä ei jää.</p>
        <p>Aloita puskurista yllätyksiä varten: rikkoutunut puhelin, hammaslääkäri, pesukone. Pienikin summa
        kuukaudessa auttaa. Tapa on tärkeämpi kuin summa.</p>
        <p>Kun puskuri on olemassa, yllätys on vain meno eikä kriisi.</p>`,
    },
  },
  {
    id: 'ahead',
    action: { tab: 'year' },
    en: {
      title: 'Look ahead: are problems coming?',
      body: `
        <p>This is where a budget really pays off. Plan the whole year, then look at the bottom rows of
        <b>{tab.year}</b>:</p>
        <ul>
          <li><b>{year.plannedNet}</b> shows whether each month ends in plus or minus. Red means that month spends
          more than it earns.</li>
          <li><b>{year.cumPlan}</b> shows how things develop over the year. If it turns red, you will run out
          of money at that point unless something changes.</li>
        </ul>
        <p>A red month isn’t a disaster. It’s a warning that arrives in time: you can save beforehand, move an
        expense, or look for extra income.</p>
        <p>If the plan shows problems you can’t solve on your own, get help early, before bills become overdue.
        In Finland, free help is available from the debt advice service of the public legal aid offices
        (<i>talous- ja velkaneuvonta</i>) and from Takuusäätiö.</p>`,
    },
    fi: {
      title: 'Katso eteenpäin: onko tulossa ongelmia?',
      body: `
        <p>Tässä budjetti todella maksaa itsensä takaisin. Suunnittele koko vuosi ja katso sitten
        <b>{tab.year}</b>-näkymän alimpia rivejä:</p>
        <ul>
          <li><b>{year.plannedNet}</b> näyttää, jääkö kuukausi plussalle vai miinukselle. Punainen
          tarkoittaa, että kuukauden menot ovat tuloja suuremmat.</li>
          <li><b>{year.cumPlan}</b> näyttää, miten tilanne kehittyy vuoden mittaan. Jos se muuttuu
          punaiseksi, rahat loppuvat siinä kohtaa, ellei jokin muutu.</li>
        </ul>
        <p>Punainen kuukausi ei ole katastrofi. Se on varoitus, joka tulee ajoissa: voit säästää etukäteen,
        siirtää menoa tai etsiä lisätuloja.</p>
        <p>Jos suunnitelma näyttää ongelmia, joita et saa ratkaistua yksin, hae apua ajoissa, ennen kuin laskut
        erääntyvät. Maksutonta apua saa oikeusaputoimistojen talous- ja velkaneuvonnasta sekä
        Takuusäätiöltä.</p>`,
    },
  },
  {
    id: 'track',
    action: { tab: 'month', focus: 'amount' },
    en: {
      title: 'Track during the month',
      body: `
        <p>Enter expenses as they happen. On a phone it takes seconds. Many people find it easiest to do it right
        away, or once a day in the evening.</p>
        <p>The <b>{tab.month}</b> view shows how much is left in each category. When a bar turns red, that category is
        over plan. That’s information, not failure: decide whether to spend less somewhere else, or accept it.</p>
        <p>Certain categories are counted automatically, so you only need to enter them when the amount is
        different from the plan.</p>`,
    },
    fi: {
      title: 'Seuraa kuukauden aikana',
      body: `
        <p>Kirjaa menot sitä mukaa kuin niitä tulee. Puhelimella se vie sekunteja. Monelle helpointa on kirjata
        heti tai kerran päivässä illalla.</p>
        <p><b>{tab.month}</b>-näkymä näyttää, paljonko kussakin luokassa on jäljellä. Kun palkki muuttuu punaiseksi,
        luokan suunnitelma on ylittynyt. Se on tietoa eikä epäonnistumista: päätä, säästätkö jostain muualta vai
        hyväksytkö sen.</p>
        <p>Varmat luokat lasketaan automaattisesti, joten ne tarvitsee kirjata vain, jos summa poikkeaa
        suunnitellusta.</p>`,
    },
  },
  {
    id: 'review',
    action: { tab: 'month', prevMonth: true },
    en: {
      title: 'Review the month',
      body: `
        <p>At the end of each month, take ten minutes to compare the plan with what actually happened.</p>
        <p>Where did the plan miss? Update the coming months to match reality. The plan gets better every month.</p>
        <p>Notice what went well, too. Every month you stay on plan, money becomes a little more of a resource
        and a little less of a worry.</p>
        <p>That’s the whole method: <b>plan, track, review</b>, again and again.</p>`,
    },
    fi: {
      title: 'Käy kuukausi läpi',
      body: `
        <p>Varaa kuun lopussa kymmenen minuuttia ja vertaa suunnitelmaa siihen, mitä oikeasti tapahtui.</p>
        <p>Missä suunnitelma meni ohi? Päivitä tulevat kuukaudet vastaamaan todellisuutta. Suunnitelma
        tarkentuu joka kuukausi.</p>
        <p>Huomaa myös, mikä meni hyvin. Jokainen kuukausi, jonka pysyt suunnitelmassa, tekee rahasta vähän
        enemmän voimavaran ja vähän vähemmän huolen.</p>
        <p>Siinä on koko menetelmä: <b>suunnittele, seuraa, tarkista</b>, yhä uudelleen.</p>`,
    },
  },
];
