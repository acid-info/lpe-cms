import type { Schema, Attribute } from '@strapi/strapi';

export interface BlocksCodeBlock extends Schema.Component {
  collectionName: 'components_blocks_code_blocks';
  info: {
    displayName: 'Code Block';
    description: '';
  };
  attributes: {
    language: Attribute.String;
    code: Attribute.Text;
  };
}

export interface BlocksInteractiveEmbed extends Schema.Component {
  collectionName: 'components_blocks_interactive_embeds';
  info: {
    displayName: 'Interactive Embed';
    description: '';
  };
  attributes: {
    title: Attribute.String;
    full_html: Attribute.Text;
    html: Attribute.Text;
    css: Attribute.Text;
    js: Attribute.Text;
    height: Attribute.Integer;
  };
}

export interface BlocksRichText extends Schema.Component {
  collectionName: 'components_blocks_rich_texts';
  info: {
    displayName: 'Rich Text';
    description: '';
  };
  attributes: {
    body: Attribute.RichText &
      Attribute.CustomField<
        'plugin::ckeditor.CKEditor',
        {
          output: 'HTML';
          preset: 'standard';
        }
      >;
  };
}

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
      'blocks.code-block': BlocksCodeBlock;
      'blocks.interactive-embed': BlocksInteractiveEmbed;
      'blocks.rich-text': BlocksRichText;
      'cat.channel': CatChannel;
    }
  }
}
