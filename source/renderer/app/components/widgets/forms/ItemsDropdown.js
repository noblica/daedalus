// @flow
import React, { Component } from 'react';
import { filter, escapeRegExp } from 'lodash';
import { Select } from 'react-polymorph/lib/components/Select';
import { SelectSkin } from 'react-polymorph/lib/skins/simple/SelectSkin';
import ItemDropdownOption from './ItemDropdownOption';
import type { ItemDropdown } from './ItemDropdownOption';

/**
 *
 * This component extends the React Polymorph's Select component
 * Any prop from it can be used
 * Reference:
 * https://github.com/input-output-hk/react-polymorph/blob/develop/source/components/Select.js
 *
 */
export type ItemDropdownProps = {
  options: Array<ItemDropdown>,
};

export const onSearchItemsDropdown = (
  searchValue: string,
  options: Array<any>
) => {
  return filter(options, (option) => {
    const { label, detail, value } = option;
    const regex = new RegExp(escapeRegExp(searchValue), 'i');
    return regex.test(label) || regex.test(detail) || regex.test(value);
  });
};

export default class ItemsDropdown extends Component<ItemDropdownProps> {
  static defaultProps = {
    optionRenderer: (optionProps: ItemDropdown) => (
      <ItemDropdownOption {...optionProps} />
    ),
    selectionRenderer: (optionProps: ItemDropdown) => (
      <ItemDropdownOption selected {...optionProps} />
    ),
    onSearch: onSearchItemsDropdown,
    skin: SelectSkin,
  };
  render() {
    return <Select {...this.props} optionHeight={50} />;
  }
}
