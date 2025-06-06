
// Experimental HDF5 reader

import * as zip from './zip.js';

const hdf5 = {};

hdf5.File = class {

    static open(data) {
        if (data && data.length >= 8) {
            const buffer = data instanceof Uint8Array ? data : data.peek(8);
            const signature = [0x89, 0x48, 0x44, 0x46, 0x0D, 0x0A, 0x1A, 0x0A]; // \x89HDF\r\n\x1A\n
            if (signature.every((value, index) => value === buffer[index])) {
                return new hdf5.File(data);
            }
        }
        return null;
    }

    constructor(data) {
        this.data = data;
    }

    read() {
        if (this.data) {
            // https://support.hdfgroup.org/HDF5/doc/H5.format.html
            const data = this.data;
            delete this.data;
            const reader = hdf5.Reader.open(data);
            reader.skip(8);
            this._globalHeap = new hdf5.GlobalHeap(reader);
            const version = reader.byte();
            switch (version) {
                case 0:
                case 1: {
                    this._freeSpaceStorageVersion = reader.byte();
                    this._rootGroupEntryVersion = reader.byte();
                    reader.skip(1);
                    this._sharedHeaderMessageVersionFormat = reader.byte();
                    reader.initialize();
                    reader.skip(1);
                    this._groupLeafNodeK = reader.uint16(); // 0x04?
                    this._groupInternalNodeK = reader.uint16(); // 0x10?
                    reader.skip(4);
                    if (version > 0) {
                        this._indexedStorageInternalNodeK = reader.uint16();
                        this.skip(2); // Reserved
                    }
                    this._baseAddress = reader.offset();
                    reader.offset(); // Address of File Free space Info
                    this._endOfFileAddress = reader.offset();
                    reader.offset(); // Driver Information Block Address
                    if (this._baseAddress !== 0) {
                        throw new hdf5.Error('Base address is not zero.');
                    }
                    const rootGroupEntry = new hdf5.SymbolTableEntry(reader);
                    this._rootGroup = new hdf5.Group(reader, rootGroupEntry, null, this._globalHeap, '', '');
                    break;
                }
                case 2:
                case 3: {
                    reader.initialize();
                    reader.byte();
                    this._baseAddress = reader.offset();
                    this._superBlockExtensionAddress = reader.offset();
                    this._endOfFileAddress = reader.offset();
                    const rootGroupObjectHeader = new hdf5.DataObjectHeader(reader, reader.offset());
                    this._rootGroup = new hdf5.Group(reader, null, rootGroupObjectHeader, this._globalHeap, '', '');
                    break;
                }
                default:
                    throw new hdf5.Error(`Unsupported Superblock version ${version}.`);
            }
            delete this.data;
        }
        return this._rootGroup;
    }
};

hdf5.Group = class {

    constructor(reader, entry, objectHeader, globalHeap, parentPath, name) {
        this._reader = reader;
        this._entry = entry;
        this._dataObjectHeader = objectHeader;
        this._globalHeap = globalHeap;
        this._name = name;
        this._path = parentPath === '/' ? (parentPath + name) : (`${parentPath}/${name}`);
    }

    get name() {
        return this._name;
    }

    get path() {
        return this._path;
    }

    group(path) {
        this._decodeGroups();
        if (this._groups.has(path)) {
            return this._groups.get(path);
        }
        const index = path.indexOf('/');
        if (index !== -1) {
            const group = this.group(path.substring(0, index));
            if (group) {
                return group.group(path.substring(index + 1));
            }
        }
        return null;
    }

    get groups() {
        this._decodeGroups();
        return this._groups;
    }

    get attributes() {
        this._decodeDataObject();
        return this._attributes;
    }

    get value() {
        this._decodeDataObject();
        return this._value;
    }

    _decodeDataObject() {
        if (!this._dataObjectHeader) {
            this._dataObjectHeader = new hdf5.DataObjectHeader(this._reader, this._entry.objectHeaderAddress);
        }
        if (!this._attributes) {
            this._attributes = new Map();
            for (const attribute of this._dataObjectHeader.attributes) {
                const name = attribute.name;
                const value = attribute.decodeValue(this._globalHeap);
                this._attributes.set(name, value);
            }
            this._value = null;
            const datatype = this._dataObjectHeader.datatype;
            const dataspace = this._dataObjectHeader.dataspace;
            const dataLayout = this._dataObjectHeader.dataLayout;
            const filterPipeline = this._dataObjectHeader.filterPipeline;
            if (datatype && dataspace && dataLayout) {
                this._value = new hdf5.Variable(this._reader, this._globalHeap, datatype, dataspace, dataLayout, filterPipeline);
            }
        }
        if (this._reader.position !== 0) {
            this._reader.seek(0);
        }
    }

    _decodeGroups() {
        if (!this._groups) {
            this._groups = new Map();
            if (this._entry) {
                if (this._entry.treeAddress || this._entry.heapAddress) {
                    const heap = new hdf5.Heap(this._reader, this._entry.heapAddress);
                    const tree = new hdf5.Tree(this._reader, this._entry.treeAddress);
                    for (const node of tree.nodes) {
                        for (const entry of node.entries) {
                            const name = heap.getString(entry.linkNameOffset);
                            const group = new hdf5.Group(this._reader, entry, null, this._globalHeap, this._path, name);
                            this._groups.set(name, group);
                        }
                    }
                }
            } else {
                this._decodeDataObject();
                for (const link of this._dataObjectHeader.links) {
                    if (Object.prototype.hasOwnProperty.call(link, 'objectHeaderAddress')) {
                        const name = link.name;
                        const objectHeader = new hdf5.DataObjectHeader(this._reader, link.objectHeaderAddress);
                        const linkGroup = new hdf5.Group(this._reader, null, objectHeader, this._globalHeap, this._path, name);
                        this._groups.set(name, linkGroup);
                    }
                }
            }
        }
    }
};

hdf5.Variable = class {

    constructor(reader, globalHeap, datatype, dataspace, dataLayout, filterPipeline) {
        this._reader = reader;
        this._globalHeap = globalHeap;
        this._datatype = datatype;
        this._dataspace = dataspace;
        this._dataLayout = dataLayout;
        this._filterPipeline = filterPipeline;
    }

    get type () {
        return this._datatype.type;
    }

    get littleEndian() {
        return this._datatype.littleEndian;
    }

    get shape() {
        return this._dataspace.shape;
    }

    get value() {
        const data = this.data;
        if (data) {
            const reader = hdf5.Reader.open(data);
            const array = this._dataspace.read(this._datatype, reader);
            return this._dataspace.decode(this._datatype, array, array, this._globalHeap);
        }
        return null;
    }

    get data() {
        switch (this._dataLayout.layoutClass) {
            case 1: // Contiguous
                if (this._dataLayout.address && this._dataLayout.address !== -1) {
                    const position = this._reader.position;
                    this._reader.seek(this._dataLayout.address);
                    const stream = this._reader.stream(this._dataLayout.size);
                    this._reader.seek(position);
                    return stream;
                }
                break;
            case 2: { // Chunked
                const dimensionality = this._dataLayout.dimensionality;
                const tree = new hdf5.Tree(this._reader, this._dataLayout.address, dimensionality);
                const item_size = this._dataLayout.datasetElementSize;
                const chunk_shape = this._dataLayout.dimensionSizes;
                const data_shape = this._dataspace.shape;
                const chunk_size = chunk_shape.reduce((a, b) => a * b, 1);
                const data_size = data_shape.reduce((a, b) => a * b, 1);
                const max_dim = data_shape.length - 1;
                let data_stride = 1;
                const data_strides = new Array(data_shape.length);
                for (let i = data_shape.length - 1; i >= 0; i--) {
                    data_strides[i] = data_stride;
                    data_stride *= data_shape[i];
                }
                const data = new Uint8Array(data_size * item_size);
                for (const node of tree.nodes) {
                    let chunk = node.data;
                    if (this._filterPipeline) {
                        for (let i = 0; i < this._filterPipeline.filters.length; i++) {
                            if ((node.filterMask & (1 << i)) === 0) {
                                const filter = this._filterPipeline.filters[i];
                                chunk = filter.decode(chunk);
                            }
                        }
                    }
                    const chunk_offset = node.fields.map((x) => x.toNumber());
                    const data_pos = chunk_offset.slice();
                    const chunk_pos = new Array(data_pos.length).fill(0);
                    const length = data_pos.length - 1;
                    for (let chunk_index = 0; chunk_index < chunk_size; chunk_index++) {
                        for (let i = max_dim; i >= 0; i--) {
                            if (chunk_pos[i] >= chunk_shape[i]) {
                                chunk_pos[i] = 0;
                                data_pos[i] = chunk_offset[i];
                                if (i > 0) {
                                    chunk_pos[i - 1]++;
                                    data_pos[i - 1]++;
                                }
                            } else {
                                break;
                            }
                        }
                        let index = 0;
                        let inbounds = true;
                        for (let i = 0; i < length; i++) {
                            const position = data_pos[i];
                            if (position >= data_shape[i]) {
                                inbounds = false;
                                break;
                            }
                            index += position * data_strides[i];
                        }
                        if (inbounds) {
                            let chunk_offset = chunk_index * item_size;
                            let target_offset = index * item_size;
                            const target_end = target_offset + item_size;
                            while (target_offset < target_end) {
                                data[target_offset++] = chunk[chunk_offset++];
                            }
                        }
                        chunk_pos[max_dim]++;
                        data_pos[max_dim]++;
                    }
                }
                return data;
            }
            default: {
                throw new hdf5.Error(`Unsupported data layout class '${this.layoutClass}'.`);
            }
        }
        return null;
    }
};

hdf5.Reader = class {

    static open(data) {
        if (data instanceof hdf5.BinaryReader || data instanceof hdf5.StreamReader) {
            return data;
        } else if (data instanceof Uint8Array) {
            return new hdf5.BinaryReader(data);
        } else if (data.length < 0x10000000) {
            const buffer = data.peek();
            return new hdf5.BinaryReader(buffer);
        }
        return new hdf5.StreamReader(data);
    }

    initialize() {
        this._offsetSize = this.byte();
        this._lengthSize = this.byte();
    }

    int8() {
        const position = this.take(1);
        return this._view.getInt8(position);
    }

    byte() {
        const position = this.take(1);
        return this._view.getUint8(position);
    }

    int16() {
        const position = this.take(2);
        return this._view.getInt16(position, true);
    }

    uint16() {
        const position = this.take(2);
        return this._view.getUint16(position, true);
    }

    int32() {
        const position = this.take(4);
        return this._view.getInt32(position, true);
    }

    uint32() {
        const position = this.take(4);
        return this._view.getUint32(position, true);
    }

    int64() {
        const position = this.take(8);
        return this._view.getBigInt64(position, true);
    }

    uint64() {
        const position = this.take(8);
        return this._view.getBigUint64(position, true);
    }

    uint(size) {
        switch (size) {
            case 0: return this.byte();
            case 1: return this.uint16();
            case 2: return this.uint32();
            case 3: return this.uint64().toNumber();
            default: throw new hdf5.Error(`Unsupported uint size '${size}'.`);
        }
    }

    float16() {
        const position = this.take(2);
        const value = this._view.getUint16(position, true);
        // decode float16 value
        const s = (value & 0x8000) >> 15;
        const e = (value & 0x7C00) >> 10;
        const f = value & 0x03FF;
        if (e === 0) {
            return (s ? -1 : 1) * Math.pow(2, -14) * (f / Math.pow(2, 10));
        } else if (e === 0x1F) {
            return f ? NaN : ((s ? -1 : 1) * Infinity);
        }
        return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + (f / Math.pow(2, 10)));
    }

    float32() {
        const position = this.take(4);
        return this._view.getFloat32(position, true);
    }

    float64() {
        const position = this.take(8);
        return this._view.getFloat64(position, true);
    }

    offset() {
        switch (this._offsetSize) {
            case 8: {
                const position = this.take(8);
                const value = this._view.getBigUint64(position, true);
                if (value === 0xffffffffffffffffn) {
                    return -1;
                }
                if (value >= Number.MAX_SAFE_INTEGER) {
                    throw new Error(`64-bit value '${value.toString(16)}' exceeds safe integer.`);
                }
                return value.toNumber();
            }
            case 4: {
                const value = this.uint32();
                if (value === 0xffffffff) {
                    return undefined;
                }
                return value;
            }
            default: {
                throw new hdf5.Error(`Unsupported offset size '${this._offsetSize}'.`);
            }
        }
    }

    length() {
        switch (this._lengthSize) {
            case 8: {
                const position = this.take(8);
                const value = this._view.getBigUint64(position, true);
                if (value === 0xffffffffffffffffn) {
                    return -1;
                }
                if (value >= Number.MAX_SAFE_INTEGER) {
                    throw new Error(`64-bit value '${value.toString(16)}' exceeds safe integer.`);
                }
                return value.toNumber();
            }
            case 4: {
                const value = this.uint32();
                if (value === 0xffffffff) {
                    return undefined;
                }
                return value;
            }
            default: {
                throw new hdf5.Error(`Unsupported length size '${this._lengthSize}'.`);
            }
        }
    }

    string(size, encoding) {
        if (!size || size === -1) {
            size = this.size(0x00);
        }
        let data = null;
        if (size < 16) {
            data = new Uint8Array(size);
            for (let i = 0; i < size; i++) {
                data[i] = this.byte();
            }
        } else {
            data = this.read(size);
        }
        if (encoding === 'utf-8') {
            hdf5.Reader._utf8Decoder = hdf5.Reader._utf8Decoder || new TextDecoder('utf-8');
            return hdf5.Reader._utf8Decoder.decode(data).replace(/\0/g, '');
        }
        hdf5.Reader._asciiDecoder = hdf5.Reader._asciiDecoder || new TextDecoder('ascii');
        return hdf5.Reader._asciiDecoder.decode(data).replace(/\0/g, '');
    }

    match(signature) {
        const position = this.position;
        for (let i = 0; i < signature.length; i++) {
            if (signature.charCodeAt(i) !== this.byte()) {
                this.seek(position);
                return false;
            }
        }
        return true;
    }

    expect(signature) {
        if (!this.match(signature)) {
            throw new hdf5.Error(`Invalid '${signature}' block signature.`);
        }
    }
};

hdf5.BinaryReader = class extends hdf5.Reader {

    constructor(buffer, view, offset, position, offsetSize, lengthSize) {
        super();
        this._buffer = buffer;
        this._length = buffer.length;
        this._view = view || new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        this._offset = offset || 0;
        this._position = position || 0;
        this._offsetSize = offsetSize;
        this._lengthSize = lengthSize;
    }

    get position() {
        return this._position + this._offset;
    }

    take(offset) {
        const position = this._offset + this._position;
        this.skip(offset);
        return position;
    }

    seek(position) {
        this._offset = position;
        this._position = 0;
        if (this._offset > this._length) {
            throw new Error(`Unexpected end of file. Expected ${this._offset - this._length} more bytes. The file might be corrupted.`);
        }
    }

    skip(offset) {
        this._position += offset;
        if (this._offset + this._position > this._buffer.length) {
            throw new hdf5.Error(`Unexpected end of file. Expected ${this._offset + this._position - this._buffer.length} more bytes. The file might be corrupted.`);
        }
    }

    align(mod) {
        if (this._position % mod !== 0) {
            this._position = (Math.floor(this._position / mod) + 1) * mod;
        }
    }

    peek(length) {
        const position = this._offset + this._position;
        length = length === undefined ? this._buffer.length - position : length;
        this.take(length);
        const buffer = this._buffer.subarray(position, position + length);
        this._position = position - this._offset;
        return buffer;
    }

    read(length) {
        const position = this.take(length);
        return this._buffer.subarray(position, position + length);
    }

    stream(length) {
        const position = this.take(length);
        const buffer = this._buffer.subarray(position, position + length);
        return new hdf5.BinaryReader(buffer);
    }

    size(terminator) {
        let position = this._offset + this._position;
        while (this._buffer[position] !== terminator) {
            position++;
        }
        return position - this._offset - this._position + 1;
    }
};

hdf5.StreamReader = class extends hdf5.Reader {

    constructor(stream, view, window, offset, position, offsetSize, lengthSize) {
        super();
        this._stream = stream;
        this._length = stream.length;
        this._view = view;
        this._window = window || 0;
        this._offset = offset || 0;
        this._position = position || 0;
        this._offsetSize = offsetSize;
        this._lengthSize = lengthSize;
    }

    get position() {
        return this._offset + this._position;
    }

    seek(position) {
        this._offset = position;
        this._position = 0;
        if (this._offset > this._length) {
            throw new Error(`Unexpected end of file. Expected ${this._offset - this._length} more bytes. The file might be corrupted.`);
        }
    }

    skip(offset) {
        this._position += offset;
        if (this._position + this._offset > this._length) {
            throw new hdf5.Error(`Unexpected end of file. Expected ${this._position + this._offset - this._length} more bytes. The file might be corrupted.`);
        }
    }

    align(mod) {
        if (this._position % mod !== 0) {
            this._position = (Math.floor(this._position / mod) + 1) * mod;
        }
    }

    read(length) {
        const position = this._stream.position;
        this._stream.seek(this._offset + this._position);
        const buffer = this._stream.read(length);
        this._stream.seek(position);
        this.skip(length);
        return buffer;
    }

    stream(length) {
        const position = this._stream.position;
        this._stream.seek(this._offset + this._position);
        this.skip(length);
        const stream = this._stream.stream(length);
        this._stream.seek(position);
        return stream;
    }

    byte() {
        const position = this.take(1);
        return this._view.getUint8(position);
    }

    uint16() {
        const position = this.take(2);
        return this._view.getUint16(position, true);
    }

    int32() {
        const position = this.take(4);
        return this._view.getInt32(position, true);
    }

    uint32() {
        const position = this.take(4);
        return this._view.getUint32(position, true);
    }

    int64() {
        const position = this.take(8);
        return this._view.getBigInt64(position, true);
    }

    float32() {
        const position = this.take(4);
        return this._view.getFloat32(position, true);
    }

    float64() {
        const position = this.take(8);
        return this._view.getFloat64(position, true);
    }

    size(terminator) {
        const position = this._position;
        let size = 0;
        while (this.byte() !== terminator) {
            size++;
        }
        this._position = position;
        return size;
    }

    take(length) {
        const position = this.position;
        if (position + length > this._length) {
            throw new Error(`Expected ${position + length - this._length} more bytes. The file might be corrupted. Unexpected end of file.`);
        }
        if (!this._view || position < this._window || position + length > this._window + this._view.byteLength) {
            this._window = position;
            const current = this._stream.position;
            this._stream.seek(this._window);
            const buffer = this._stream.read(Math.min(0x100, this._length - this._window)).slice();
            this._view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
            this._stream.seek(current);
        }
        this._position += length;
        return position - this._window;
    }
};

hdf5.SymbolTableNode = class {

    constructor(reader, offset) {
        const position = reader.position;
        reader.seek(offset);
        reader.expect('SNOD');
        const version = reader.byte();
        if (version === 1) {
            reader.skip(1);
            const entriesUsed = reader.uint16();
            this.entries = [];
            for (let i = 0; i < entriesUsed; i++) {
                const entry = new hdf5.SymbolTableEntry(reader);
                this.entries.push(entry);
            }
        } else {
            throw new hdf5.Error(`Unsupported symbol table node version '${version}'.`);
        }
        reader.seek(position);
    }
};

hdf5.SymbolTableEntry = class {

    constructor(reader) {
        this.linkNameOffset = reader.offset();
        this.objectHeaderAddress = reader.offset();
        const cacheType = reader.uint32();
        reader.skip(4); // Reserved
        switch (cacheType) {
            case 0:
                break;
            case 1: {
                const position = reader.position;
                this.treeAddress = reader.offset();
                this.heapAddress = reader.offset();
                reader.seek(position);
                break;
            }
            default:
                throw new hdf5.Error(`Unsupported cache type '${cacheType}'.`);
        }
        reader.skip(16); // Scratch-pad space
    }
};

hdf5.DataObjectHeader = class {

    constructor(reader, offset) {
        // https://support.hdfgroup.org/HDF5/doc/H5.format.html#ObjectHeader
        const position = reader.position;
        reader.seek(offset);
        this.attributes = [];
        this.links = [];
        this.continuations = [];
        reader.match('OHDR');
        const version = reader.byte();
        switch (version) {
            case 1: {
                reader.skip(1);
                const count = reader.uint16();
                reader.uint32();
                const objectHeaderSize = reader.uint32();
                reader.align(8);
                let end = reader.position + objectHeaderSize;
                for (let i = 0; i < count; i++) {
                    const type = reader.uint16();
                    const size = reader.uint16();
                    const flags = reader.byte();
                    reader.skip(3);
                    reader.align(8);
                    const next = this._readMessage(reader, type, size, flags);
                    if ((!next || reader.position >= end) && this.continuations.length > 0) {
                        const continuation = this.continuations.shift();
                        reader.seek(continuation.offset);
                        end = continuation.offset + continuation.length;
                    } else {
                        reader.align(8);
                    }
                }
                break;
            }
            case 2: {
                const flags = reader.byte();
                if ((flags & 0x20) !== 0) {
                    reader.uint32(); // access time
                    reader.uint32(); // modification time
                    reader.uint32(); // change time
                    reader.uint32(); // birth time
                }
                if ((flags & 0x10) !== 0) {
                    reader.uint16(); // max compact attributes
                    reader.uint16(); // min compact attributes
                }
                const order = (flags & 0x04) !== 0;
                const size = reader.uint(flags & 0x03);
                let next = true;
                let end = reader.position + size;
                while (next && reader.position < end) {
                    const type = reader.byte();
                    const size = reader.uint16();
                    const flags = reader.byte();
                    if (reader.position < end) {
                        if (order) {
                            reader.uint16(); // creation order
                        }
                        next = this._readMessage(reader, type, size, flags);
                    }
                    if ((!next || reader.position >= end) && this.continuations.length > 0) {
                        const continuation = this.continuations.shift();
                        reader.seek(continuation.offset);
                        end = continuation.offset + continuation.length;
                        reader.expect('OCHK');
                        next = true;
                    }
                }
                break;
            }
            default: {
                throw new hdf5.Error(`Unsupported data object header version '${version}'.`);
            }
        }
        reader.seek(position);
    }

    _readMessage(reader, type, size, flags) {
        const position = reader.position;
        switch (type) {
            case 0x0000: // NIL
                return false;
            case 0x0001: // Dataspace
                this.dataspace = (size !== 4 || flags !== 1) ? new hdf5.Dataspace(reader) : null;
                break;
            case 0x0002: // Link Info
                this.linkInfo = new hdf5.LinkInfo(reader);
                break;
            case 0x0003: // Datatype
                this.datatype = new hdf5.Datatype(reader);
                break;
            case 0x0004:
            case 0x0005: // Fill Value
                this.fillValue = new hdf5.FillValue(reader, type);
                break;
            case 0x0006: // Link
                this.links.push(new hdf5.Link(reader));
                break;
            case 0x0008: // Data Layout
                this.dataLayout = new hdf5.DataLayout(reader);
                break;
            case 0x000A: // Group Info
                this.groupInfo = new hdf5.GroupInfo(reader);
                break;
            case 0x000B: // Filter Pipeline
                this.filterPipeline = new hdf5.FilterPipeline(reader);
                break;
            case 0x000C: // Attribute
                this.attributes.push(new hdf5.Attribute(reader));
                break;
            case 0x000D: // Object Comment Message
                this.comment = reader.string(-1, 'ascii');
                break;
            case 0x0010: // Object Header Continuation
                this.continuations.push(new hdf5.ObjectHeaderContinuation(reader));
                break;
            case 0x0011: // Symbol Table
                this.symbolTable = new hdf5.SymbolTable(reader);
                break;
            case 0x000E: // Object Modification Time (Old)
            case 0x0012: // Object Modification Time
                this.objectModificationTime = new hdf5.ObjectModificationTime(reader, type);
                break;
            case 0x0015: // Attribute Info
                this.attributeInfo = new hdf5.AttributeInfo(reader);
                break;
            default:
                throw new hdf5.Error(`Unsupported message type '${type}'.`);
        }
        reader.seek(position);
        reader.skip(size);
        return true;
    }
};

hdf5.Message = class {

    constructor(type, data, flags) {
        this._type = type;
        this._data = data;
        this._flags = flags;
    }
};

hdf5.Dataspace = class {

    constructor(reader) {
        // https://support.hdfgroup.org/HDF5/doc/H5.format.html#DataspaceMessage
        this._sizes = [];
        const version = reader.byte();
        switch (version) {
            case 1:
                this._dimensions = reader.byte();
                this._flags = reader.byte();
                reader.skip(1);
                reader.skip(4);
                for (let i = 0; i < this._dimensions; i++) {
                    this._sizes.push(reader.length());
                }
                if ((this._flags & 0x01) !== 0) {
                    this._maxSizes = [];
                    for (let j = 0; j < this._dimensions; j++) {
                        this._maxSizes.push(reader.length());
                        if (this._maxSizes[j] !== this._sizes[j]) {
                            throw new hdf5.Error('Max size is not supported.');
                        }
                    }
                }
                if ((this._flags & 0x02) !== 0) {
                    throw new hdf5.Error('Permutation indices not supported.');
                }
                break;
            case 2:
                this._dimensions = reader.byte();
                this._flags = reader.byte();
                this._type = reader.byte(); // 0 scalar, 1 simple, 2 null
                for (let k = 0; k < this._dimensions; k++) {
                    this._sizes.push(reader.length());
                }
                if ((this._flags & 0x01) !== 0) {
                    this._maxSizes = [];
                    for (let l = 0; l < this._dimensions; l++) {
                        this._maxSizes.push(reader.length());
                    }
                }
                break;
            default:
                throw new hdf5.Error(`Unsupported dataspace message version '${version}'.`);
        }
    }

    get shape() {
        return this._sizes;
    }

    read(datatype, reader) {
        if (this._dimensions === 0) {
            return datatype.read(reader);
        }
        return this._readArray(datatype, reader, this._sizes, 0);
    }

    _readArray(datatype, reader, shape, dimension) {
        const array = [];
        const size = shape[dimension];
        if (dimension === shape.length - 1) {
            for (let i = 0; i < size; i++) {
                array.push(datatype.read(reader));
            }
        } else {
            for (let j = 0; j < size; j++) {
                array.push(this._readArray(datatype, reader, shape, dimension + 1));
            }
        }
        return array;
    }

    decode(datatype, data, globalHeap) {
        if (this._dimensions === 0) {
            return datatype.decode(data, globalHeap);
        }
        return this._decodeArray(datatype, data, globalHeap, this._sizes, 0);
    }

    _decodeArray(datatype, data, globalHeap, shape, dimension) {
        const size = shape[dimension];
        if (dimension === shape.length - 1) {
            for (let i = 0; i < size; i++) {
                data[i] = datatype.decode(data[i], globalHeap);
            }
        } else {
            for (let j = 0; j < size; j++) {
                data[j] = this._decodeArray(datatype, data[j], shape, dimension + 1);
            }
        }
        return data;
    }
};

hdf5.LinkInfo = class {

    constructor(reader) {
        const version = reader.byte();
        switch (version) {
            case 0: {
                const flags = reader.byte();
                if ((flags & 1) !== 0) {
                    this.maxCreationIndex = reader.uint64();
                }
                this.fractalHeapAddress = reader.offset();
                this.nameIndexTreeAddress = reader.offset();
                if ((flags & 2) !== 0) {
                    this.creationOrderIndexTreeAddress = reader.offset();
                }
                break;
            }
            default:
                throw new hdf5.Error(`Unsupported link info message version '${version}'.`);
        }
    }
};

hdf5.Datatype = class {

    constructor(reader) {
        // https://support.hdfgroup.org/HDF5/doc/H5.format.html#DatatypeMessage
        const format = reader.byte();
        const version = format >> 4;
        this._class = format & 0xf;
        switch (version) {
            case 1:
            case 2: {
                this._flags = reader.byte() | reader.byte() << 8 | reader.byte() << 16;
                this._size = reader.uint32();
                switch (this._class) {
                    case 0: { // fixed-Point
                        this._bitOffset = reader.uint16();
                        this._bitPrecision = reader.uint16();
                        break;
                    }
                    case 8: { // enumerated
                        this._base = new hdf5.Datatype(reader);
                        reader.seek(reader.position);
                        const size = this._flags & 0xffff;
                        this._names = new Array(size);
                        for (let i = 0; i < size; i++) {
                            this._names[i] = reader.string(-1, 'ascii');
                            reader.align(8);
                        }
                        this._values = new Array(size);
                        for (let i = 0; i < size; i++) {
                            this._values[i] = this._base.read(reader);
                        }
                        break;
                    }
                    default: {
                        break;
                    }
                }
                break;
            }
            default: {
                throw new hdf5.Error(`Unsupported datatype version '${version}'.`);
            }
        }
    }

    get type() {
        switch (this._class) {
            case 0: // fixed-point
                if ((this._flags & 0xfff6) === 0) {
                    if ((this._flags && 0x08) === 0) {
                        switch (this._size) {
                            case 1: return 'uint8';
                            case 2: return 'uint16';
                            case 4: return 'uint32';
                            case 8: return 'uint64';
                            default: throw new hdf5.Error(`Unsupported uint size '${this._size}'.`);
                        }
                    } else {
                        switch (this._size) {
                            case 1: return 'int8';
                            case 2: return 'int16';
                            case 4: return 'int32';
                            case 8: return 'int64';
                            default: throw new hdf5.Error(`Unsupported int size '${this._size}'.`);
                        }
                    }
                }
                break;
            case 1: // floating-point
                if (this._size === 2 && this._flags === 0x0f20) {
                    return 'float16';
                } else if (this._size === 4 && this._flags === 0x1f20) {
                    return 'float32';
                } else if (this._size === 8 && this._flags === 0x3f20) {
                    return 'float64';
                }
                break;
            case 3: // string
                return 'string';
            case 5: // opaque
                return 'uint8';
            case 6: // compound
                return 'compound';
            case 8: // enumerated
                if (this._base.type === 'int8' &&
                    this._names.length === 2 && this._names[0] === 'FALSE' && this._names[1] === 'TRUE' &&
                    this._values.length === 2 && this._values[0] === 0 && this._values[1] === 1) {
                    return 'boolean';
                }
                break;
            case 9: // variable-length
                if ((this._flags & 0x0f) === 1) { // type
                    return 'char[]';
                }
                break;
            default:
                break;
        }
        throw new hdf5.Error(`Unsupported datatype class '${this._class}'.`);
    }

    get littleEndian() {
        switch (this._class) {
            case 0: // fixed-point
            case 1: // floating-point
                return (this.flags & 0x01) === 0;
            default:
                return true;
        }
    }

    read(reader) {
        switch (this._class) {
            case 0: // fixed-point
                if (this._size === 1) {
                    return this._flags & 0x8 ? reader.int8() : reader.byte();
                } else if (this._size === 2) {
                    return this._flags & 0x8 ? reader.int16() : reader.uint16();
                } else if (this._size === 4) {
                    return this._flags & 0x8 ? reader.int32() : reader.uint32();
                } else if (this._size === 8) {
                    return this._flags & 0x8 ? reader.int64() : reader.uint64();
                }
                throw new hdf5.Error('Unsupported fixed-point datatype.');
            case 1: // floating-point
                if (this._size === 2 && this._flags === 0x0f20) {
                    return reader.float16();
                } else if (this._size === 4 && this._flags === 0x1f20) {
                    return reader.float32();
                } else if (this._size === 8 && this._flags === 0x3f20) {
                    return reader.float64();
                }
                throw new hdf5.Error('Unsupported floating-point datatype.');
            case 3: // string
                switch ((this._flags >> 8) & 0x0f) { // character set
                    case 0:
                        return reader.string(this._size, 'ascii');
                    case 1:
                        return reader.string(this._size, 'utf-8');
                    default:
                        throw new hdf5.Error('Unsupported character encoding.');
                }
            case 5: // opaque
                return reader.read(this._size);
            case 8: // enumerated
                return reader.read(this._size);
            case 9: // variable-length
                return {
                    length: reader.uint32(),
                    globalHeapID: new hdf5.GlobalHeapID(reader)
                };
            default:
                throw new hdf5.Error(`Unsupported datatype class '${this._class}'.`);
        }
    }

    decode(data, globalHeap) {
        switch (this._class) {
            case 0: // fixed-point
                return data;
            case 1: // floating-point
                return data;
            case 3: // string
                return data;
            case 5: // opaque
                return data;
            case 8: // enumerated
                return data;
            case 9: { // variable-length
                const globalHeapObject = globalHeap.get(data.globalHeapID);
                if (globalHeapObject !== null) {
                    const characterSet = (this._flags >> 8) & 0x0f;
                    const reader = globalHeapObject.reader();
                    switch (characterSet) {
                        case 0:
                            return reader.string(reader.length(), 'ascii');
                        case 1:
                            return reader.string(reader.length(), 'utf-8');
                        default:
                            throw new hdf5.Error('Unsupported character encoding.');
                    }
                }
                break;
            }
            default:
                throw new hdf5.Error(`Unsupported datatype class '${this._class}'.`);
        }
        return null;
    }
};

hdf5.FillValue = class {

    constructor(reader, type) {
        // https://support.hdfgroup.org/HDF5/doc/H5.format.html#FillValueMessage
        switch (type) {
            case 0x0004: {
                const size = reader.uint32();
                this.data = reader.read(size);
                break;
            }
            case 0x0005:
            default: {
                const version = reader.byte();
                switch (version) {
                    case 1:
                    case 2: {
                        reader.byte();
                        reader.byte();
                        const valueDefined = reader.byte();
                        if (version === 1 || valueDefined === 1) {
                            const size = reader.uint32();
                            this.data = reader.read(size);
                        }
                        break;
                    }
                    case 3: {
                        const flags = reader.byte();
                        if ((flags & 0x20) !== 0) {
                            const size = reader.uint32();
                            this.data = reader.read(size);
                        }
                        break;
                    }
                    default:
                        throw new hdf5.Error(`Unsupported fill value version '${version}'.`);
                }
                break;
            }
        }
    }
};

hdf5.Link = class {

    constructor(reader) {
        // https://support.hdfgroup.org/HDF5/doc/H5.format.html#FillValueMessage
        const version = reader.byte();
        switch (version) {
            case 1: {
                const flags = reader.byte();
                this.type = (flags & 0x08) === 0 ? 0 : reader.byte();
                if ((flags & 0x04) !== 0) {
                    this.creationOrder = reader.uint32();
                }
                const encoding = ((flags & 0x10) !== 0 && reader.byte() === 1) ? 'utf-8' : 'ascii';
                const size = reader.uint(flags & 0x03);
                this.name = reader.string(size, encoding);
                switch (this.type) {
                    case 0: // hard link
                        this.objectHeaderAddress = reader.offset();
                        break;
                    case 1: // soft link
                        break;
                    default:
                        throw new hdf5.Error(`Unsupported link message type '${this.type}'.`);
                }
                break;
            }
            default:
                throw new hdf5.Error(`Unsupported link message version '${version}'.`);
        }
    }
};

hdf5.DataLayout = class {

    constructor(reader) {
        // https://support.hdfgroup.org/HDF5/doc/H5.format.html#LayoutMessage
        const version = reader.byte();
        switch (version) {
            case 1:
            case 2: {
                this.dimensionality = reader.byte();
                this.layoutClass = reader.byte();
                reader.skip(5);
                switch (this.layoutClass) {
                    case 1:
                        this.address = reader.offset();
                        this.dimensionSizes = [];
                        for (let i = 0; i < this.dimensionality - 1; i++) {
                            this.dimensionSizes.push(reader.int32());
                        }
                        break;
                    case 2: // Chunked
                        this.address = reader.offset();
                        this.dimensionSizes = [];
                        for (let i = 0; i < this.dimensionality - 1; i++) {
                            this.dimensionSizes.push(reader.int32());
                        }
                        this.datasetElementSize = reader.int32();
                        break;
                    default:
                        throw new hdf5.Error(`Unsupported data layout class '${this.layoutClass}'.`);
                }
                break;
            }
            case 3: {
                this.layoutClass = reader.byte();
                switch (this.layoutClass) {
                    case 0: // Compact
                        this.size = reader.uint16();
                        reader.skip(2);
                        this.address = reader.position;
                        break;
                    case 1: // Contiguous
                        this.address = reader.offset();
                        this.size = reader.length();
                        break;
                    case 2: // Chunked
                        this.dimensionality = reader.byte();
                        this.address = reader.offset();
                        this.dimensionSizes = [];
                        for (let i = 0; i < this.dimensionality - 1; i++) {
                            this.dimensionSizes.push(reader.int32());
                        }
                        this.datasetElementSize = reader.int32();
                        break;
                    default:
                        throw new hdf5.Error(`Unsupported data layout class '${this.layoutClass}'.`);
                }
                break;
            }
            default: {
                throw new hdf5.Error(`Unsupported data layout version '${version}'.`);
            }
        }
    }
};

hdf5.GroupInfo = class {

    constructor(reader) {
        const version = reader.byte();
        switch (version) {
            case 0: {
                const flags = reader.byte();
                if ((flags & 0x01) !== 0) {
                    this.maxCompactLinks = reader.uint16();
                    this.minDenseLinks = reader.uint16();
                }
                if ((flags & 0x02) !== 0) {
                    this.estimatedEntriesNumber = reader.uint16();
                    this.estimatedLinkNameLengthEntries = reader.uint16();
                }
                break;
            }
            default:
                throw new hdf5.Error(`Unsupported group info version '${version}'.`);
        }
    }
};

hdf5.FilterPipeline = class {

    constructor(reader) {
        // https://support.hdfgroup.org/HDF5/doc/H5.format.html#FilterMessage
        const version = reader.byte();
        switch (version) {
            case 1: {
                this.filters = [];
                const numberOfFilters = reader.byte();
                reader.skip(2);
                reader.skip(4);
                for (let i = 0; i < numberOfFilters; i++) {
                    this.filters.push(new hdf5.Filter(reader));
                    reader.align(8);
                }
                break;
            }
            default:
                throw new hdf5.Error(`Unsupported filter pipeline message version '${version}'.`);
        }
    }
};

hdf5.Filter = class {

    constructor(reader) {
        this.id = reader.int16();
        const nameLength = reader.int16();
        this.flags = reader.int16();
        const clientDataSize = reader.int16();
        this.name = reader.string(nameLength, 'ascii');
        this.clientData = reader.read(clientDataSize * 4);
    }

    decode(data) {
        switch (this.id) {
            case 1: return this._deflate(data);
            case 32000: return this._lzf(data);
            default: throw new hdf5.Error(`Unsupported filter '${this.id}:${this.name}'.`);
        }
    }

    _deflate(input) {
        const archive = zip.Archive.open(input);
        return archive.entries.get('').peek();
    }

    _lzf(input) {
        let i = 0;
        let o = 0;
        while (i < input.length) {
            let c = input[i++];
            if (c < (1 << 5)) {
                c++;
                i += c;
                o += c;
                if (i > input.length) {
                    throw new Error('Invalid LZF compressed data.');
                }
            } else {
                let length = c >> 5;
                if (i >= input.length) {
                    throw new Error('Invalid LZF compressed data.');
                }
                if (length === 7) {
                    length += input[i++];
                    if (i >= input.length) {
                        throw new Error('Invalid LZF compressed data.');
                    }
                }
                const ref =  (o - ((c & 0x1f) << 8) - 1) - input[i++];
                if (ref < 0) {
                    throw new Error('Invalid LZF compressed data.');
                }
                o += length + 2;
            }
        }
        const output = new Uint8Array(o);
        i = 0;
        o = 0;
        while (i < input.length) {
            let c = input[i++];
            if (c < (1 << 5)) {
                c++;
                output.set(input.subarray(i, i + c), o);
                i += c;
                o += c;
            } else {
                let length = c >> 5;
                if (length === 7) {
                    length += input[i++];
                }
                length += 2;
                let ref =  o - ((c & 0x1f) << 8) - 1 - input[i++];
                do {
                    output[o++] = output[ref++];
                } while (--length);
            }
        }
        return output;
    }
};

hdf5.Attribute = class {

    constructor(reader) {
        const version = reader.byte();
        switch (version) {
            case 1: {
                reader.skip(1);
                const nameSize = reader.uint16();
                const datatypeSize = reader.uint16();
                const dataspaceSize = reader.uint16();
                this.name = reader.string(nameSize, 'utf-8');
                reader.align(8);
                const datatypePosition = reader.position;
                this._datatype = new hdf5.Datatype(reader);
                reader.seek(datatypePosition);
                reader.skip(datatypeSize);
                reader.align(8);
                const dataspacePosition = reader.position;
                this._dataspace = new hdf5.Dataspace(reader);
                reader.seek(dataspacePosition);
                reader.skip(dataspaceSize);
                reader.align(8);
                this._data = this._dataspace.read(this._datatype, reader);
                break;
            }
            case 3: {
                reader.byte();
                const nameSize = reader.uint16();
                const datatypeSize = reader.uint16();
                const dataspaceSize = reader.uint16();
                const encoding = reader.byte() === 1 ? 'utf-8' : 'ascii';
                this.name = reader.string(nameSize, encoding);
                const datatypePosition = reader.position;
                this._datatype = new hdf5.Datatype(reader);
                reader.seek(datatypePosition);
                reader.skip(datatypeSize);
                const dataspacePosition = reader.position;
                this._dataspace = new hdf5.Dataspace(reader);
                reader.seek(dataspacePosition);
                reader.skip(dataspaceSize);
                this._data = this._dataspace.read(this._datatype, reader);
                break;
            }
            default:
                throw new hdf5.Error(`Unsupported attribute message version '${version}'.`);
        }
    }

    decodeValue(globalHeap) {
        if (this._data) {
            return this._dataspace.decode(this._datatype, this._data, globalHeap);
        }
        return null;
    }
};

hdf5.ObjectHeaderContinuation = class {

    constructor(reader) {
        this.offset = reader.offset();
        this.length = reader.length();
    }
};

hdf5.SymbolTable = class {

    constructor(reader) {
        this.treeAddress = reader.offset();
        this.heapAddress = reader.offset();
    }
};

hdf5.ObjectModificationTime = class {

    constructor(reader, type) {
        // https://support.hdfgroup.org/HDF5/doc/H5.format.html#ModificationTimeMessage
        switch (type) {
            case 0x000E: {
                this.year = reader.uint32();
                this.month = reader.uint16();
                this.day = reader.uint16();
                this.hour = reader.uint16();
                this.minute = reader.uint16();
                this.second = reader.uint16();
                reader.skip(2);
                break;
            }
            case 0x0012: {
                const version = reader.byte();
                reader.skip(3);
                switch (version) {
                    case 1:
                        this.timestamp = reader.uint32();
                        break;
                    default:
                        throw new hdf5.Error(`Unsupported object modification time message version '${version}'.`);
                }
                break;
            }
            default: {
                throw new hdf5.Error(`Unsupported object modification time message type '${type}'.`);
            }
        }
    }
};

hdf5.AttributeInfo = class {

    constructor(reader) {
        const version = reader.byte();
        switch (version) {
            case 0: {
                const flags = reader.byte();
                if ((flags & 1) !== 0) {
                    this.maxCreationIndex = reader.uint64();
                }
                this.fractalHeapAddress = reader.offset();
                this.attributeNameTreeAddress = reader.offset();
                if ((flags & 2) !== 0) {
                    this.attributeCreationOrderTreeAddress = reader.offset();
                }
                break;
            }
            default:
                throw new hdf5.Error(`Unsupported attribute info message version '${version}'.`);
        }
    }
};

hdf5.Tree = class {

    constructor(reader, offset, dimensionality) {
        // https://support.hdfgroup.org/HDF5/doc/H5.format.html#V1Btrees
        const position = reader.position;
        reader.seek(offset);
        reader.expect('TREE');
        this.type = reader.byte();
        this.level = reader.byte();
        const entries = reader.uint16();
        reader.offset(); // address of left sibling
        reader.offset(); // address of right sibling
        this.nodes = [];
        switch (this.type) {
            case 0: { // Group nodes
                for (let i = 0; i < entries; i++) {
                    reader.length();
                    const childPointer = reader.offset();
                    if (this.level === 0) {
                        const node = new hdf5.SymbolTableNode(reader, childPointer);
                        this.nodes.push(node);
                    } else {
                        const tree = new hdf5.Tree(reader, childPointer);
                        this.nodes.push(...tree.nodes);
                    }
                }
                break;
            }
            case 1: { // Raw data chunk nodes
                for (let i = 0; i < entries; i++) {
                    const size = reader.int32();
                    const filterMask = reader.int32();
                    const fields = [];
                    for (let j = 0; j < dimensionality; j++) {
                        fields.push(reader.uint64());
                    }
                    const childPointer = reader.offset();
                    if (this.level === 0) {
                        const position = reader.position;
                        reader.seek(childPointer);
                        const data = reader.read(size);
                        this.nodes.push({ data, fields, filterMask });
                        reader.seek(position);
                    } else {
                        const tree = new hdf5.Tree(reader, childPointer, dimensionality);
                        this.nodes.push(...tree.nodes);
                    }
                }
                break;
            }
            default: {
                throw new hdf5.Error(`Unsupported B-Tree node type '${this.type}'.`);
            }
        }
        reader.seek(position);
    }
};

hdf5.Heap = class {

    constructor(reader, offset) {
        const position = reader.position;
        reader.seek(offset);
        this._reader = reader;
        reader.expect('HEAP');
        const version = reader.byte();
        switch (version) {
            case 0: {
                reader.skip(3);
                this._dataSize = reader.length();
                this._offsetToHeadOfFreeList = reader.length();
                this._dataAddress = reader.offset();
                break;
            }
            default: {
                throw new hdf5.Error(`Unsupported Local Heap version '${version}'.`);
            }
        }
        reader.seek(position);
    }

    getString(offset) {
        const position = this._reader.position;
        this._reader.seek(this._dataAddress + offset);
        const value = this._reader.string(-1, 'utf-8');
        this._reader.seek(position);
        return value;
    }
};

hdf5.GlobalHeap = class {

    constructor(reader) {
        this._reader = reader;
        this._collections = new Map();
    }

    get(globalHeapID) {
        const address = globalHeapID.address;
        if (!this._collections.has(address)) {
            this._collections.set(address, new hdf5.GlobalHeapCollection(this._reader, address));
        }
        const collection = this._collections.get(globalHeapID.address);
        return collection.getObject(globalHeapID.objectIndex);
    }
};

hdf5.GlobalHeapCollection = class {

    constructor(reader, offset) {
        const position = reader.position;
        reader.seek(offset);
        const start = reader.position;
        reader.expect('GCOL');
        const version = reader.byte();
        switch (version) {
            case 1: {
                reader.skip(3);
                this._objects = new Map();
                const size = reader.length();
                const end = start + size;
                while (reader.position < end) {
                    const index = reader.uint16();
                    if (index === 0) {
                        break;
                    }
                    this._objects.set(index, new hdf5.GlobalHeapObject(reader));
                    reader.align(8);
                }
                break;
            }
            default: {
                throw new hdf5.Error(`Unsupported global heap collection version '${version}'.`);
            }
        }
        reader.seek(position);
    }

    getObject(objectIndex) {
        if (this._objects.has(objectIndex)) {
            return this._objects.get(objectIndex);
        }
        return null;
    }
};

hdf5.GlobalHeapObject = class {

    constructor(reader) {
        reader.uint16();
        reader.skip(4);
        this._position = reader.position;
        this._reader = reader;
        const length = reader.length();
        reader.skip(length);
    }

    reader() {
        this._reader.seek(this._position);
        return this._reader;
    }
};

hdf5.GlobalHeapID = class {

    constructor(reader) {
        this.address = reader.offset();
        this.objectIndex = reader.uint32();
    }
};

hdf5.Error = class extends Error {

    constructor(message) {
        super(message);
        this.name = 'HDF5 Error';
    }
};

export const File = hdf5.File;
