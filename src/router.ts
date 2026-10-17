export interface Route {
  bookId: string | null;
  chId: string | null;
  secId: string | null;
  path: string | null;
  train: boolean;
}

const DEFAULT_SECTION = 'intro';

export function parseHash(hash: string = typeof location !== 'undefined' ? location.hash : ''): Route {
  const route: Route = {
    bookId: null,
    chId: null,
    secId: null,
    path: null,
    train: false,
  };

  if (!hash || !hash.startsWith('#/')) {
    return route;
  }

  const [hashPart, query = ''] = hash.slice(1).split('?');
  const segments = hashPart.split('/').filter(Boolean);

  if (segments.length > 0) {
    route.bookId = decodeURIComponent(segments[0]);
  }
  if (segments.length > 1) {
    route.chId = decodeURIComponent(segments[1]);
  }
  if (segments.length > 2) {
    route.secId = decodeURIComponent(segments[2]);
  } else if (route.chId) {
    route.secId = DEFAULT_SECTION;
  }

  if (query) {
    const params = new URLSearchParams(query);
    const path = params.get('p');
    if (path !== null) {
      route.path = path;
    }
    route.train = params.get('train') === '1' || params.get('train') === 'true';
  }

  return route;
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

export function setHash(route: Partial<Route>): string {
  let hash: string;

  if (!route.bookId) {
    hash = '#/';
  } else {
    const parts = [
      '',
      encodeSegment(route.bookId),
    ];
    if (route.chId) {
      parts.push(encodeSegment(route.chId));
      const secId = route.secId ?? DEFAULT_SECTION;
      parts.push(encodeSegment(secId));
    }
    hash = '#' + parts.join('/');

    const params = new URLSearchParams();
    if (route.path) {
      params.set('p', route.path);
    }
    if (route.train) {
      params.set('train', '1');
    }
    const query = params.toString();
    if (query) {
      hash += '?' + query;
    }
  }

  if (typeof history !== 'undefined' && typeof location !== 'undefined') {
    history.replaceState(null, '', hash);
  }

  return hash;
}

export function bookHref(bookId: string): string {
  return `#/${encodeSegment(bookId)}`;
}

export function chapterHref(bookId: string, chId: string): string {
  return `#/${encodeSegment(bookId)}/${encodeSegment(chId)}/${DEFAULT_SECTION}`;
}

export function sectionHref(
  bookId: string,
  chId: string,
  secId: string,
  path?: string | null,
  train?: boolean,
): string {
  let href = `#/${encodeSegment(bookId)}/${encodeSegment(chId)}/${encodeSegment(secId)}`;

  const params = new URLSearchParams();
  if (path) {
    params.set('p', path);
  }
  if (train) {
    params.set('train', '1');
  }

  const query = params.toString();
  if (query) {
    href += '?' + query;
  }

  return href;
}
