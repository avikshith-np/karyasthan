// Guide: Public site (pages/public.js). Plain data, see components/guide.js.
export default {
  title: 'Public site',
  intro: [
    'The public site shows his simulated life to anyone: what he is doing now, his days, his cast, story chapters, stats, journal entries you published and open Ask-me decisions people can vote on. The bot builds a filtered snapshot every few minutes and pushes it to Cloudflare. Nothing on this machine is reachable from the internet.',
    'Never on the site: chat text, chat or group names, numbers, real names of people you have not switched on, his home or exact coordinates, the mind\'s notes, claims, the tray, costs, or unpublished journal nights. A heavy stretch shows only as "going through a hard stretch". Every string is checked for names, numbers and links before upload; anything that fails is left out, and a snapshot that fails the schema is not uploaded at all (the previous one stays up).',
    'The public-site skill (Skills page) switches exporting on or off; PUBLIC_SITE_ENABLED is only its boot default. It needs the life skill on.',
  ],
  sections: [
    {
      id: 'status',
      title: 'Status',
      where: 'STATUS panel',
      items: [
        ['R2', 'CONFIGURED when R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are set in .env. Otherwise the snapshot is only written to data/public/public.json.'],
        ['VOTES WORKER', 'CONFIGURED when PUBLIC_VOTES_URL and PUBLIC_VOTES_READ_TOKEN are set: the bot pulls vote counts after each export.'],
        ['DRY_RUN', 'With DRY_RUN on nothing is uploaded; the local file is still written.'],
        ['LAST BUILD / REFUSED FIELDS', 'OK, or why the last snapshot was not built (life off, the names check unavailable, a schema error). HISTORY_TOO_LARGE: his event log has grown past what one export may read (about a million rows of one kind), so nothing is published rather than a snapshot with missing history; the previous one stays up. Refused fields name the place in the document, never the value.'],
        ['PRIVACY REFRESH', 'Switching a person off, purging a shown person or unpublishing a journal night must reach the live site. The bot exports at once; if that can\'t be built or uploaded, or the public-site skill is off, it replaces the site with the offline notice instead. PENDING means it is still trying (every few minutes).'],
        ['UPLOAD', 'ok, dry_run, not_configured, or the upload error. An unchanged snapshot is re-uploaded at most every 30 minutes; a failed upload of new content is retried at the next export.'],
      ],
      tips: [
        'EXPORT NOW builds and uploads at once (2 per minute).',
        'TAKE OFFLINE replaces the live snapshot with an "offline" notice. Turn the skill off as well, or the next export brings the site back.',
      ],
    },
    {
      id: 'people',
      title: 'People shown by name',
      where: 'PEOPLE SHOWN BY NAME panel',
      text: ['Everyone you have switched on (or off again) from their person page. Everyone else appears on the site as "a friend". Switching a person off removes their name from the next export, on every page of the site.'],
    },
    {
      id: 'preview',
      title: 'What\'s public now',
      where: 'WHAT\'S PUBLIC NOW panel',
      text: ['The exact JSON document the last export built: this is everything the site knows. Place and cast ids are salted hashes, places are snapped to about a kilometre, and his home has no pin or name — nor does any home he had or is moving to, and a place in the same cell as one of them is listed without a pin.'],
    },
  ],
};
