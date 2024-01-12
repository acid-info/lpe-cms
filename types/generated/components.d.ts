import type { Schema, Attribute } from '@strapi/strapi';

export interface CatChannel extends Schema.Component {
  collectionName: 'components_cat_channels';
  info: {
    displayName: 'Channel';
    icon: 'television';
  };
  attributes: {
    channel: Attribute.Enumeration<
      ['Spotify', 'Youtube', 'Simplecast', 'Google Podcasts', 'Apple Podcasts']
    >;
    link: Attribute.Text & Attribute.Required;
  };
}

declare module '@strapi/types' {
  export module Shared {
    export interface Components {
      'cat.channel': CatChannel;
    }
  }
}
