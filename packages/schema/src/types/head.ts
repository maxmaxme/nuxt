import type { AriaAttributes, DataKeys, GlobalAttributes, SerializableHead } from '@unhead/vue/types'

export type MetaObjectRaw = SerializableHead
export type MetaObject = MetaObjectRaw

export type AppHeadMetaObject = MetaObjectRaw & {
  /**
   * The character encoding in which the document is encoded => `<meta charset="<value>" />`
   */
  charset?: string
  /**
   * Configuration of the viewport (the area of the window in which web content can be seen),
   * mapped to => `<meta name="viewport" content="<value>" />`
   */
  viewport?: string
}

export type SerializableHtmlAttributes = GlobalAttributes & AriaAttributes & DataKeys
