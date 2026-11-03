// Guide: Life · Map (pages/life-map.js). Plain data, see components/guide.js.
export default {
  title: 'Map',
  intro: [
    'The places in his simulated world, where he is right now, the trips he made in the last 48 hours and the trips still planned for the rest of today. It is a read-only view: nothing here changes his behaviour. New places, real venues and routes are added on the Director page (PLACES panel).',
    'The map is a Leaflet map with map tiles. The tiles are loaded by your browser from LIFE_MAP_TILE_URL (by default OpenStreetMap\'s tile server, which installs now use unless the variable is set empty): that host sees your IP address, the dashboard\'s origin and the area you look at, never the dashboard\'s pages. OpenStreetMap\'s tile policy asks for light use and kept attribution (bottom right), so the map is drawn once per visit and the 30-second refresh only updates its markers and lines.',
    'With LIFE_MAP_TILE_URL empty, or if the map library (bundled with the dashboard, no outside request) fails to load, the map is drawn locally on a plain grid instead, with no outside request at all.',
  ],
  sections: [
    {
      id: 'map',
      title: 'Map',
      where: 'MAP panel (on a phone it takes most of the screen, leaving room to scroll past it; the grid version scrolls sideways and starts with him in view)',
      items: [
        ['Dots', 'His places, labelled by name, with home and office in their own colours. Hover for the kind, and for a real venue its area. A far place (for example a family home in another town) is outside the first view: zoom out to see it.'],
        ['Home area', 'Home is drawn as a 400 m circle, not a pin.'],
        ['Red dot', 'Where he is now. While travelling it moves along the straight line between the two places.'],
        ['Solid lines', 'Trips of the last 48 hours. The three most recent are highlighted. A trip follows the road when a route was fetched for its two places (Director PLACES panel, OSRM); otherwise it is a straight line. A past trip keeps the route it was planned with even if a place moved since.'],
        ['Dashed lines', 'Trips still planned for the rest of today (his day plan).'],
        ['Scale', 'Bottom left, for distances.'],
      ],
      tips: [
        'The panel head says which map is drawn: LEAFLET, or LOCAL GRID when tiles are off (LIFE_MAP_TILE_URL empty) or the library did not load.',
        'On the local grid, places far from the rest are diamonds on the border in their direction with the distance in km, so they don\'t squash the neighbourhood into a corner (far = more than 15 km and more than four times the typical distance from the middle of his places); a trip to one is dashed.',
      ],
    },
    {
      id: 'header',
      title: 'Header',
      where: 'top right',
      items: [
        ['PLACES', 'How many places his world has.'],
        ['TRIPS', 'Trips in the last 48 hours, plus how many are still planned for today.'],
        ['NOW', 'The place he is at, or TRAVELLING.'],
      ],
    },
    {
      id: 'places',
      title: 'Places',
      where: 'PLACES panel (folded away on a phone; tap to open, it remembers)',
      text: [
        'Every place with its id, name, kind and coordinates. The id is what the Director forms and the Timeline\'s event details refer to.',
        'Once some place is a real venue (made real on the Director page), the table also shows VENUE and AREA. Past trips and pins always show a place\'s current name, also after it was renamed or moved.',
      ],
    },
    {
      id: 'trips',
      title: 'Trips',
      where: 'TRIPS panel',
      text: [
        'Trips still planned for today come first (marked planned, with the planned arrival), then the trips of the last 48 hours, newest first: when he left, from where to where, how (walk, cab, scooter, metro…) and when he arrived. ARRIVED is the actual arrival from his event log; the planned one (departure plus the trip\'s duration) is shown next to it in brackets only when he arrived more than a minute late. A trip still under way says "en route · planned HH:MM"; one with no arrival in the log (e.g. cut short by a new trip) says "not logged".',
        'How he travels comes from the simulation: in rain a short trip is usually on foot with an umbrella (he packs one when the morning forecast says rain) and a longer one by cab, unless money is tight; caught out without one he gets soaked and may be late. Driving or riding himself makes him busy (slow to reply) for the trip, while as a passenger or on foot he is only lightly busy.',
      ],
      tips: ['Trips that were undone (reverted or rewound) are left out.'],
    },
  ],
};
