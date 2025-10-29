import json
import tempfile
import shutil
import numpy as np

from girder.constants import TokenScope, AccessType
from girder.exceptions import ValidationException
from girder.models.file import File
from girder.models.folder import Folder
from girder.models.collection import Collection
from girder.models.item import Item
from girder.plugin import GirderPlugin
from girder import events
from girder.api import access
from girder.api.describe import Description, autoDescribeRoute
from girder.api.rest import Resource, filtermodel

import SimpleITK as sitk

import configparser

class GirderPlugin(GirderPlugin):
    DISPLAY_NAME = 'SegVerViewer'
    CLIENT_SOURCE_PATH = 'web_client'

    def load(self, info):
        Item().exposeFields(level=AccessType.READ, fields={'segmentation'})

        # File handlers

        # Needed for the time being
        events.bind('data.process', 'segmentation_viewer', _upload_handler)
        # Needed for the time being
        events.bind('model.file.remove', 'segmentation_viewer', _deletion_handler)

        events.bind('rest.get.file/:id.after', 'segmentation_viewer', _file_get_handler)

        # Endpoints
        # Needed for the time being, until we make the final implementation for source volume and segmentation list endpoints
        info['apiRoot'].item.route(
            'POST',
            (':id', 'detect_images'),
            SegmentationItem().detect_images
        )

        info['apiRoot'].file.route(
            'POST',
            (':id', 'set_seg_tag'),
            SegmentationItem().set_seg_tag
        )

        info['apiRoot'].file.route(
            'POST',
            (':id', 'set_seg_comment'),
            SegmentationItem().set_seg_comment
        )

        info['apiRoot'].segmentation = SegmentationItem()


class SegmentationItem(Resource):
    def __init__(self):
        super().__init__()
        self.resourceName = 'segmentation'
        self.item_class = Item()

        # TODO: Not needed anymore
        self.route(
            'POST',
            (),
            self.create_segmentation_item
        )

        # Related to segverhandler indexing
        self.route(
            'GET',
            (':id', 'is_segverhandler_instance'),
            self.is_segverhandler_instance
        )
        self.route(
            'GET',
            (':id', 'get_index'),
            self.get_index
        )
        self.route(
            'GET',
            (':id', 'get_all_index_files'),
            self.get_all_index_files
        )
        self.route(
            'GET',
            (':id', 'get_volume_files'),
            self.get_volume_files
        )
        self.route(
            'GET',
            (':id', 'get_seg_files'),
            self.get_seg_files
        )

        # Will likely get reworked later
        self.route(
            'GET',
            (':id', 'base_image_data'),
            self.get_base_image_data_json
        )
        # Will likely get reworked later
        self.route(
            'GET',
            ('segmentation_data',),
            self.get_seg_data_json
        )
        # Will likely get reworked later
        self.route(
            'GET',
            ('diff_data',),
            self.get_seg_diff_data_json
        )

    # TODO: Not needed anymore
    @access.user(scope=TokenScope.DATA_WRITE)
    @filtermodel(model=Item)
    @autoDescribeRoute(
        Description('Create a new segmentation item ')
        .responseClass('Item')
        .modelParam('folderId', 'The ID of the parent folder.', model=Folder,
                    level=AccessType.WRITE, paramType='query')
        .param('name', 'Name for the item.', strip=True)
        .param('base_image_id', 'Base image file ID')
        .param('description', 'Description for the item.', required=False,
               default='', strip=True)
        .param('reuse_existing', 'Return existing item (by name) if it exists.',
               required=False, dataType='boolean', default=False)
        .jsonParam('metadata', 'A JSON object containing the metadata keys to add',
                   paramType='form', requireObject=True, required=False)
        .errorResponse()
        .errorResponse('Write access was denied on the parent folder.', 403)
    )
    def create_segmentation_item(self, folder, name, base_image_id, description, reuse_existing,
                                 metadata):
        """
        Create a file and immediately set the segmentation property within it
        """
        base_image_file = File().load(base_image_id, force=True)
        if not base_image_file:
            raise ValidationException('Base image ID is invalid.', 'base_image_id')
        if not _is_readable_by_sitk(base_image_file):
            raise ValidationException('Referenced file is not an image', 'base_image_id')

        new_item = self.item_class.createItem(
            folder=folder, name=name, creator=self.getCurrentUser(),
            description=description, reuseExisting=reuse_existing
        )
        if metadata:
            new_item = self.item_class.setMetadata(item=new_item, metadata=metadata)

        new_item['segmentation'] = {
            'base_image': {
                'name': base_image_file['name'],
                '_id': base_image_file['_id'],
            }
        }
        Item().save(new_item)
        return new_item
    
    @access.user(scope=TokenScope.DATA_READ)
    @autoDescribeRoute(
        Description('Get index file for a collection with a segVerHandler instance')
        .modelParam(
            'id',
            'Collection ID',
            model='collection',
            level=AccessType.READ,
            paramType='path'
        )
        .errorResponse('Collection ID was invalid')
        .errorResponse('Read permission denied on the base image item', 403)
    )
    def is_segverhandler_instance(self, collection) -> None:
        """
        Get index file for a collection with a segVerHandler instance
        """
        config, index, active_index = _get_segverhandler_instance(collection)
        if not config or not index or not active_index:
            return False
        return True

    @access.user(scope=TokenScope.DATA_READ)
    @autoDescribeRoute(
        Description('Get index file for a collection with a segVerHandler instance')
        .modelParam(
            'id',
            'Collection ID',
            model='collection',
            level=AccessType.READ,
            paramType='path'
        )
        .errorResponse('Collection ID was invalid')
        .errorResponse('Read permission denied on the base image item', 403)
    )
    def get_index(self, collection) -> None:
        """
        Get index file for a collection with a segVerHandler instance
        """
        _, index, _ = _get_segverhandler_instance(collection)
        return index

    @access.user(scope=TokenScope.DATA_READ)
    @autoDescribeRoute(
        Description('Get all files within a collection related segVerHandler index')
        .modelParam(
            'id',
            'Collection ID',
            model='collection',
            level=AccessType.READ,
            paramType='path'
        )
        .errorResponse('Collection ID was invalid')
        .errorResponse('Read permission denied on the base image item', 403)
    )
    def get_all_index_files(self, collection) -> None:
        """
        Get all identified volumes within a collection with a segVerHandler instance
        """
        volume_files = _get_volume_files(collection)
        segmentation_files = _get_seg_files(collection)
        volume_files.extend(segmentation_files)
        print(volume_files)
        return volume_files


    @access.user(scope=TokenScope.DATA_READ)
    @autoDescribeRoute(
        Description('Get all volumes within a collection with a segVerHandler instance')
        .modelParam(
            'id',
            'Collection ID',
            model='collection',
            level=AccessType.READ,
            paramType='path'
        )
        .errorResponse('Collection ID was invalid')
        .errorResponse('Read permission denied on the base image item', 403)
    )
    def get_volume_files(self, collection) -> None:
        """
        Get all identified volumes within a collection with a segVerHandler instance
        """
        return _get_volume_files(collection)


    @access.user(scope=TokenScope.DATA_READ)
    @autoDescribeRoute(
        Description('Get all volumes within a collection with a segVerHandler instance')
        .modelParam(
            'id',
            'Collection ID',
            model='collection',
            level=AccessType.READ,
            paramType='path'
        )
        .errorResponse('Collection ID was invalid')
        .errorResponse('Read permission denied on the base image item', 403)
    )
    def get_seg_files(self, collection) -> None:
        """
        Get all identified segmentation files within a collection with a segVerHandler instance that belong to a specific volume
        """
        return _get_seg_files(collection)

    # Not needed anymore
    @access.user(scope=TokenScope.DATA_WRITE)
    @autoDescribeRoute(
        Description('Get and store which files within an item are images readable by itk')
        .modelParam(
            'id',
            'Item ID',
            model='item',
            level=AccessType.WRITE,
            paramType='path'
        )
        .errorResponse('ID was invalid')
        .errorResponse('Read permission denied on the item', 403)
    )
    def detect_images(self, item) -> None:
        """
        Try to get all files within an item that can be read by itk,
        if any store references to them in a new 'images' property
        within the segmentation property.
        """
        image_files = []

        for file in Item().childFiles(item):
            # Check if any files are readable by itk
            if not _is_readable_by_sitk(file):
                continue
            # Add a reference for each file that is
            image_files.append({
                'name': file['name'],
                '_id': file['_id']
            })

        if image_files:
            # Initialize segmentation property
            if 'segmentation' not in item:
                item['segmentation'] = {}
            # Save files that were readable to a new Item property
            item['segmentation']['images'] = image_files
            # Save the item
            Item().save(item)

    @access.user(scope=TokenScope.DATA_WRITE)
    @autoDescribeRoute(
        Description('Set a tag for this segmentation file')
        .modelParam(
            'id',
            'File ID',
            model='file',
            level=AccessType.WRITE,
            paramType='path'
        )
        .param(
            'tag',
            'Tag to assign to this segmentation file',
        )
        .errorResponse('Base image ID was invalid')
        .errorResponse('Read permission denied on the base image item', 403)
    )
    def set_seg_tag(self, file, tag) -> None:
        """
        Set the base image for a segmentation item
        """
        file['tag'] = tag
        File().save(file)

    @access.user(scope=TokenScope.DATA_WRITE)
    @autoDescribeRoute(
        Description('Set a comment for this segmentation file')
        .modelParam(
            'id',
            'File ID',
            model='file',
            level=AccessType.WRITE,
            paramType='path'
        )
        .param(
            'comment',
            'Comment to assign to this segmentation file',
        )
        .errorResponse('Base image ID was invalid')
        .errorResponse('Read permission denied on the base image item', 403)
    )
    def set_seg_comment(self, file, comment) -> None:
        """
        Set the segmentation comment for a file
        """
        file['comment'] = comment
        File().save(file)

    @access.user(scope=TokenScope.DATA_READ)
    @autoDescribeRoute(
        Description('Get the base image of an item as a JSON object')
        .modelParam(
            'id',
            'File ID',
            model='file',
            level=AccessType.READ,
            paramType='path'
        )
        .errorResponse('ID was invalid')
        .errorResponse('Read permission denied on the item', 403)
        .errorResponse('Item does not have a segmentation property', 400)
        .errorResponse('Item does not have a base image', 400)
    )
    def get_base_image_data_json(self, file):
        """
        Get the base image of an item as a JSON object. readable by VTKjs.
        """
        
        try:
            image, array = _read_image_with_sitk(file)

            # print(f'array len: {len(array)}, subarray len: {len(array[0])}, subsubarray len: {len(array[0][0])}')

            image_data_array = []
            for image_slice in array:
                image_data_array.append(image_slice.flatten().tolist())

            image_data = {
                'shape': image.GetSize(),
                'spacing': image.GetSpacing(),
                'origin': image.GetOrigin(),
                'direction': image.GetDirection(),
                'data': image_data_array,
            }
            # print(f'Base image data: {image_data}')
            # print(f'Shape: {image_data["shape"]}, Spacing: {image_data["spacing"]}, Origin: {image_data["origin"]}, Direction: {image_data["direction"]}')
            # print(f'Base image data length: {len(image_data["data"])}')
            return image_data
        except RuntimeError:
            raise ValidationException('Base image file is not readable by SimpleITK', 'base_image')

    @access.user(scope=TokenScope.DATA_READ)
    @autoDescribeRoute(
        Description('get a segmentation as a JSON object')
        .param(
            'seg_id',
            'Segmentation File ID',
            paramType='query'
        )
        .param(
            'volume_id',
            'Source Volume File ID',
            paramType='query'
        )
        .errorResponse('File ID was invalid')
        .errorResponse('File was not found', 400)
        .errorResponse('File was not readable by SimpleITK', 400)
    )
    def get_seg_data_json(self, seg_id, volume_id):
        """
        Get segmentation overlayed on base image as a JSON object readable by VTKjs.
        This method overlays the segmentation on top of the base image.
        """
        try:

            # Load the file objects from the provided IDs
            volume_file = File().load(volume_id, force=True)
            if not volume_file:
                raise ValidationException('Source volume file not found', 'volume_id')

            seg_file = File().load(seg_id, force=True)
            if not seg_file:
                raise ValidationException('SSegmentation file not found', 'seg_id')

            # Read both image files
            base_image_sitk, base_array = _read_image_with_sitk(volume_file)
            seg_image_sitk, seg_array = _read_image_with_sitk(seg_file)

            print(f'Seg - Base image shape: {base_array.shape}, Segmentation shape: {seg_array.shape}')
            
            # Check if arrays have the same shape
            if base_array.shape != seg_array.shape:
                print(f'Seg - Base image shape: {base_array.shape}, Segmentation shape: {seg_array.shape}')
                raise ValidationException('Base image and segmentation files must have the same dimensions', 'shape_mismatch')
            
            # print('doing filter')
            # # Convert segmentation to RGB using SimpleITK's LabelToRGBImageFilter
            # label_to_rgb_filter = sitk.LabelToRGBImageFilter()
            # rgb_image_sitk = label_to_rgb_filter.Execute(seg_image_sitk)
            # rgb_array = sitk.GetArrayFromImage(rgb_image_sitk)
            
            # print(f'Seg - RGB array shape: {rgb_array.shape}')
            
            # Get unique segmentation labels for info
            unique_labels = np.unique(seg_array)
            unique_labels_no_bg = unique_labels[unique_labels != 0]
            print(f'Seg - Found {len(unique_labels_no_bg)} unique segmentation labels: {unique_labels_no_bg}')

            overlay_array = []

            # for slice in rgb_array:
            #     print(f'Seg - Overlay color: {slice.shape}')
            #     overlay_array.append(np.array(slice).flatten().tolist())

            for slice in seg_array:
                overlay_array.append(np.array(slice).flatten().tolist())

            # Get statistics about the overlay
            unique_overlay_values = np.unique(overlay_array)
            print(f'Seg - Unique overlay values: {len(unique_overlay_values)} values')

            # Compute quantification statistics for the overlay, Still not sure how to calculate them correctly 🫠
            quantification = {
                'min': np.random.random(),
                'max': np.random.random(),
                'mean': np.random.random(),
                'sd': np.random.random(),
                'volume': np.random.randint(1, 100)
            }

            print(f'Seg - Quantification statistics: {quantification}')

            # Use base_image for spatial metadata (since both should have same metadata)
            seg_data = {
                'shape': seg_image_sitk.GetSize(),
                'spacing': base_image_sitk.GetSpacing(),
                'origin': base_image_sitk.GetOrigin(),
                'direction': base_image_sitk.GetDirection(),
                # 'data': overlay_array.flatten().tolist(),  # Convert to list for JSON serialization
                # 'data': seg_array.flatten().tolist(),  # Convert to list for JSON serialization
                'data': overlay_array,  # Convert to list for JSON serialization
                'labels': [
                    {
                        'value': int(label),
                        'color': [np.random.random() for _ in range(3)]  # Random RGB color
                    } for label in unique_labels_no_bg
                ],
                'quantification': quantification
            }
            
            # print(f'Seg - Final shape: {seg_data["shape"]}')
            # print(f'Seg - Final data length: {len(seg_data["data"])}')
            
            return seg_data
        except RuntimeError:
            raise ValidationException('Image file is not readable by SimpleITK', '')

    @access.user(scope=TokenScope.DATA_READ)
    @autoDescribeRoute(
        Description('get segmentation difference data as a JSON object')
        .param(
            'seg1_id',
            'First segmentation file ID',
            paramType='query'
        )
        .param(
            'seg2_id',
            'Second segmentation file ID',
            paramType='query'
        )
        .errorResponse('File ID was invalid')
        .errorResponse('File was not found', 400)
        .errorResponse('File was not readable by SimpleITK', 400)
    )
    def get_seg_diff_data_json(self, seg1_id, seg2_id):
        """
        Get segmentation difference data as a JSON object readable by VTKjs.
        This method computes the differences between two segmentation files.
        """
        try:
            # Load the file objects from the provided IDs
            seg1 = File().load(seg1_id, force=True)
            if not seg1:
                raise ValidationException('First segmentation file not found', 'seg1_id')
                
            seg2 = File().load(seg2_id, force=True)
            if not seg2:
                raise ValidationException('Second segmentation file not found', 'seg2_id')
            
            # Read both segmentation files
            seg1_image, seg1_array = _read_image_with_sitk(seg1)
            seg2_image, seg2_array = _read_image_with_sitk(seg2)

            # print(f'Diff - Seg1 shape: {seg1_array.shape}, Seg2 shape: {seg2_array.shape}')
            
            # Check if arrays have the same shape
            if seg1_array.shape != seg2_array.shape:
                raise ValidationException('Segmentation files must have the same dimensions', 'shape_mismatch')
            
            # Compute the absolute difference between the two segmentations
            diff_array = np.abs(seg1_array.astype(np.float32) - seg2_array.astype(np.float32))
            
            # Convert back to appropriate data type for visualization
            # diff_array = diff_array.astype(np.uint8)

            diff_data_array = []
            for diff_slice in diff_array:
                diff_data_array.append(diff_slice.flatten().tolist())
            
            # print(f'Diff - Difference array shape: {diff_array.shape}')
            # print(f'Diff - Difference array dtype: {diff_array.dtype}')
            # print(f'Diff - Difference array min: {diff_array.min()}, max: {diff_array.max()}')
            # print(f'Diff - Non-zero differences: {np.count_nonzero(diff_array)}')
            
            # Get statistics about the differences
            # unique_diff_values = np.unique(diff_array)
            # print(f'Diff - Unique difference values: {unique_diff_values}')
            
            # Use seg1_image for spatial metadata (since both should have same metadata)
            diff_data = {
                'shape': seg1_image.GetSize(),
                'spacing': seg1_image.GetSpacing(),
                'origin': seg1_image.GetOrigin(),
                'direction': seg1_image.GetDirection(),
                'data': diff_data_array,  # Convert to list for JSON serialization
                'type': 'difference',  # Add type identifier for frontend
            }
            
            # print(f'Diff - Final shape: {diff_data["shape"]}')
            # print(f'Diff - Final data length: {len(diff_data["data"])}')
            
            return diff_data
        except RuntimeError:
            raise ValidationException('Segmentation file is not readable by SimpleITK', '')


def _get_segverhandler_instance(collection: Collection):
    """
    Get all the information related to a segverhandler instance within a collection.
    """
    config = _get_segverhandler_config(collection)
    if not config:
        return (None, None, None)

    active_index = config["index"]["active"]

    index = _get_segverhandler_index(collection, active_index)
    if not index:
        return (None, None, None)

    return (config, index, active_index)


def _get_segverhandler_config(collection: Collection):
    """
    Get the .segverhandler configuration from a collection.
    
    :param collection: Girder collection object
    :return: configuration object or None if not found
    """
    folder = Folder().findOne({
        'parentId': collection['_id'],
        'parentCollection': 'collection',
        'name': '.segverhandler'
    })

    if not folder:
        return None
    
    config_file_name = 'config'

    config_item = Item().findOne({
        'folderId': folder['_id'],
        'name': config_file_name
    })

    if not config_item:
        return None

    config_file = File().findOne({
        'itemId': config_item['_id'],
        'name': config_file_name
    })

    if not config_file:
        return None

    config = configparser.ConfigParser()
    with File().open(config_file) as fp:
        config.read_string(fp.read().decode('utf-8'))
        return config


def _get_segverhandler_index(collection: Collection, active_index: str) -> dict:
    """
    Get the .segverhandler index from a collection.

    :param collection: Girder collection object
    :return: index file list or None if not found
    """
    folder = Folder().findOne({
        'parentId': collection['_id'],
        'parentCollection': 'collection',
        'name': '.segverhandler'
    })

    if not folder:
        return None

    index_name = f"{active_index}.manifest.json"

    index_item = Item().findOne({
        'folderId': folder['_id'],
        'name': index_name
    })

    if not index_item:
        return None

    index_file = File().findOne({
        'itemId': index_item['_id'],
        'name': index_name
    })

    if not index_file:
        return None
    
    with File().open(index_file) as fp:
        index = json.load(fp)

    return index


def _get_seg_files(collection: Collection) -> list:
    # Find the .segverhandler folder in this collection
    _, index, _ = _get_segverhandler_instance(collection)

    segmentation_directory = index.get('label-path', None)
    if not segmentation_directory:
        raise ValidationException('segmentation directory not specified in config', '')

    segmentation_file_extension = index.get('label-extension', None)
    if not segmentation_file_extension:
        raise ValidationException('segmentation file extension not specified in config', '')

    segmentation_folder = Folder().findOne({
        'parentId': collection['_id'],
        'name': segmentation_directory
    })

    if not segmentation_folder:
        raise ValidationException(f'segmentation directory \'{segmentation_directory}\' not found in collection', 'collection')

    segmentation_files = _lookup_files_in_folder(segmentation_folder)

    segmentation_file_data = []
    for _, volume_data in index['volumes'].items():
        for segmentation in volume_data['versions']:
            for segmentation_file in segmentation_files:
                if f'{segmentation['id']}{segmentation_file_extension}' == segmentation_file['name']:
                    segmentation_file_data.append({
                        'name': segmentation_file['name'],
                        '_id': segmentation_file['_id']
                    })
                    
    return segmentation_file_data


def _get_volume_files(collection: Collection) -> list:
    # Find the .segverhandler folder in this collection
    _, index, _ = _get_segverhandler_instance(collection)

    volumes_directory = index.get('volume-path', None)
    if not volumes_directory:
        raise ValidationException('volumes directory not specified in config', '')
    
    volume_file_extension = index.get('volume-extension', None)
    if not volume_file_extension:
        raise ValidationException('volumes file extension not specified in config', '')

    volume_folder = Folder().findOne({
        'parentId': collection['_id'],
        'name': volumes_directory
    })

    if not volume_folder:
        raise ValidationException(f'volumes directory \'{volumes_directory}\' not found in collection', 'collection')

    volumes_in_index = [f"{file}{volume_file_extension}" for file in index['volumes']]
    folder_files = _lookup_files_in_folder(volume_folder)
    volume_files = [ file for file in folder_files if file["name"] in volumes_in_index ]
    return [ {'name': file['name'], '_id': file['_id']} for file in volume_files ]



def _lookup_files_in_folder(folder: Folder) -> list:
    """
    Look up files in a folder by extension.
    """
    files = []
    for item in Item().find({'folderId': folder['_id']}):
        for file in Item().childFiles(item):
            files.append(file)

    return files


def _read_image_with_sitk(file) -> tuple:
    """
    Read a Girder file using SimpleITK and return the image and array.
    
    :param file: Girder file object
    :return: tuple (sitk_image, numpy_array)
    :raises RuntimeError: if file is not readable by SimpleITK
    """
    exts = f'.{'.'.join(file['exts'])}'
    
    # Create a temporary file with the same extension as the original
    with tempfile.NamedTemporaryFile(suffix=exts, delete=True) as tmp:
        # Download file from Girder into temp file
        with File().open(file) as fp:
            shutil.copyfileobj(fp, tmp)
            tmp.flush()  # Ensure all data is written
        
        # Read image using SimpleITK
        image = sitk.ReadImage(tmp.name)
        array = sitk.GetArrayFromImage(image)

        return image, array


def _is_readable_by_sitk(file) -> bool:
    """
    Check if a girder file is readable by SimpleITK or not.
    :param file: Girder file object
    :return: whether the file is readable by SimpleITK or not
    """
    try:
        # Try to read the image - if it succeeds, the file is readable
        _read_image_with_sitk(file)
        return True
    except RuntimeError:
        return False

# File handlers

# Needed for the time being
def _upload_handler(event):
    """
    Whenever a new file is added to an item, check if the new file
    is readable by SimpleITK. If it is, add it to the 'images' property.
    """
    # Get the ID of the file being added. If it even is a file
    file = event.info['file']
    if not _is_readable_by_sitk(file):
        return

    item = Item().load(file['itemId'], force=True)
    if 'segmentation' not in item:
        item['segmentation'] = {}

    if 'images' not in item['segmentation']:
        item['segmentation']['images'] = []

    item['segmentation']['images'].append({
        'name': file['name'],
        '_id': file['_id']
    })
    Item().save(item)
    events.trigger('segmentation_viewer.upload.success')


# Needed for the time being
def _deletion_handler(event):
    """
    Whenever a file is about to be removed, check if it was contained
    within the 'images' property. If it is, remove it.
    """
    file = event.info
    item = Item().load(file['itemId'], force=True)

    # Check if 'images' property even exists
    if 'segmentation' not in item or 'images' not in item['segmentation']:
        return

    images = []
    for image in item['segmentation']['images']:
        if image['_id'] != file['_id']:
            images.append(image)

    if images:
        item['segmentation']['images'] = images
    else:
        del item['segmentation']['images']  # Remove the property entirely if the list is empty

    Item().save(item)
    events.trigger('segmentation_viewer.file.remove.success')

def _file_get_handler(event):
    """
    Handle file get requests.
    """
    file = File().load(event.info['id'], force=True)

    if file is not None:
        if 'tag' in file:
            event.info['returnVal']['tag'] = file['tag']
        if 'comment' in file:
            event.info['returnVal']['comment'] = file['comment']

    events.trigger('segmentation_viewer.file.get.success', event)
