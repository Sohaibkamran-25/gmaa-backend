// Central pricing and event configuration.
// Add new sports here when they go live. Set signupAmount/sponsorAmount to null
// to reject paid submissions with a clear error until pricing is confirmed.

export const EVENTS = {
  soccer: {
    label: 'Soccer',
    signupAmount: 125,
    sponsorAmount: 200,
    currency: 'USD',
  },
  football: {
    label: 'Football',
    signupAmount: null,
    sponsorAmount: null,
    currency: 'USD',
  },
  volleyball: {
    label: 'Volleyball',
    signupAmount: null,
    sponsorAmount: null,
    currency: 'USD',
  },
  basketball: {
    label: 'Basketball',
    signupAmount: null,
    sponsorAmount: null,
    currency: 'USD',
  },
  cricket: {
    label: 'Cricket',
    signupAmount: null,
    sponsorAmount: null,
    currency: 'USD',
  },
  badminton: {
    label: 'Badminton',
    signupAmount: null,
    sponsorAmount: null,
    currency: 'USD',
  },
  pickleball: {
    label: 'Pickleball',
    signupAmount: null,
    sponsorAmount: null,
    currency: 'USD',
  },
  'track-field': {
    label: 'Track and Field',
    signupAmount: null,
    sponsorAmount: null,
    currency: 'USD',
  },
  mma: {
    label: 'MMA',
    signupAmount: null,
    sponsorAmount: null,
    currency: 'USD',
  },
};

export function getEventConfig(sport) {
  const config = EVENTS[sport];
  if (!config) {
    throw new Error(
      `Unknown sport: "${sport}". Add it to backend/config/events.js to support it.`
    );
  }
  return config;
}

export function getEventPricing(sport, formType) {
  const config = getEventConfig(sport);
  const amount = formType === 'sponsor' ? config.sponsorAmount : config.signupAmount;
  if (amount === null || amount === undefined || Number(amount) <= 0) {
    throw new Error('Payment is not configured for this event yet.');
  }
  return {
    amount: Number(amount).toFixed(2),
    currency: config.currency,
    label: config.label,
  };
}
