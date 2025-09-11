import { getCurrentUser } from '@girder/core/auth';
import { AccessType } from '@girder/core/constants';
import { restRequest } from '@girder/core/rest';
import events from '@girder/core/events';
import { wrap } from '@girder/core/utilities/PluginUtils';
import { ItemView } from '@girder/core/views/body';

import DetectImagesItemTemplate from './templates/detectImagesItem.pug';

import SegItemView from './views/SegView';

console.log('Loaded SegVerViewer!');

wrap(ItemView, 'render', function (render) {
    this.once('g:rendered', () => {
        // Check if the user has permissions to extract image data
        if (this.model.get('_accessLevel') >= AccessType.WRITE) {
            // Add button for image extraction
            this.$('.g-item-actions-menu').prepend(DetectImagesItemTemplate({
                item: this.model,
                currentUser: getCurrentUser()
            }));
        }

        // TODO: Should be refactored later
        if (this.model.has('segmentation')) {
            let segmentation = this.model.get('segmentation');

            console.log('Segmentation images exist:', segmentation['images']);
            if (segmentation['images'] && segmentation['images'].length > 1) {
                new SegItemView({
                    parentView: this,
                    item: this.model
                }).render()
                    .$el.insertAfter(this.$('.g-item-info'));
            }
        }
    }, this);

    render.call(this);

    return this;
});

// Needed for the time being
// Detect images button logic
ItemView.prototype.events['click .g-detect-images-item'] = function () {
    restRequest({
        method: 'POST',
        url: `item/${this.model.id}/detect_images`,
        error: null
    })
        .done((resp) => {
            // Show up a message to alert the user it was done
            events.trigger('g:alert', {
                icon: 'ok',
                text: 'Images within item detected successfully.',
                type: 'success',
                timeout: 4000
            });
        })
        .fail((resp) => {
            events.trigger('g:alert', {
                icon: 'cancel',
                text: 'Could not detect images.',
                type: 'danger',
                timeout: 4000
            });
        });
};
